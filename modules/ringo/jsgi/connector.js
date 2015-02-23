/**
 * @fileOverview Low-level JSGI adapter implementation.
 */

var {Headers, getMimeParameter} = require('ringo/utils/http');
var {Stream} = require('io');
var {Binary, ByteString} = require('binary');
var system = require('system');
var strings = require('ringo/utils/strings');
var {WriteListener, AsyncListener} = javax.servlet;
var {ConcurrentLinkedQueue} = java.util.concurrent;

export('handleRequest', 'AsyncResponse');
var log = require('ringo/logging').getLogger(module.id);

/**
 * Handle a JSGI request.
 * @param {String} moduleId the module id. Ignored if functionObj is already a function.
 * @param {Function} functionObj the function, either as function object or function name to be
 *             imported from the module moduleId.
 * @param {Object} request the JSGI request object
 * @returns {Object} the JSGI response object
 */
function handleRequest(moduleId, functionObj, request) {
    initRequest(request);
    var app;
    if (typeof(functionObj) === 'function') {
        app = functionObj;
    } else {
        var module = require(moduleId);
        app = module[functionObj];
        var middleware = module.middleware || [];
        request.env.app = moduleId;
        app = middleware.reduceRight(middlewareWrapper, resolve(app));
    }
    // if RINGO_ENV environment variable is set and application supports
    // modular JSGI environment feature use the proper environment
    if (app && system.env.RINGO_ENV && typeof(app.env) === 'function') {
        app = app.env(system.env.RINGO_ENV);
    }
    if (typeof(app) !== 'function') {
        throw new Error('No valid JSGI app: ' + app);
    }
    var result = app(request);
    if (!result) {
        throw new Error('No valid JSGI response: ' + result);
    }
    commitResponse(request, result);
}

/**
 * Set up the I/O related properties of a jsgi environment object.
 * @param {Object} request a jsgi request object
 */
function initRequest(request) {
    var input, errors;
    if (request.hasOwnProperty('input')) {
        // already set up, probably because the original request threw a retry
        return;
    }
    Object.defineProperty(request, "input", {
        get: function() {
            if (!input)
                input = new Stream(request.env.servletRequest.getInputStream());
            return input;
        },
        enumerable: true
    });
    Object.defineProperty(request.jsgi, "errors", {
        value: system.stderr
    });
}

/**
 * Apply the return value of a JSGI application to a servlet response.
 * This is used internally by the org.ringojs.jsgi.JsgiServlet class, so
 * you won't need this unless you're implementing your own servlet
 * based JSGI connector.
 *
 * @param {Object} req the JSGI request argument
 * @param {Object} result the object returned by a JSGI application
 */
function commitResponse(req, result) {
    var request = req.env.servletRequest;
    if (request.isAsyncStarted()) {
        return;
    }
    var response = req.env.servletResponse;
    var {status, headers, body} = result;
    if (!status || !headers || !body) {
        // Check if this is an asynchronous response. If not throw an Error
        throw new Error('No valid JSGI response: ' + result);
    }
    // Allow application/middleware to handle request via Servlet API
    if (!response.isCommitted() && !Headers(headers).contains("X-JSGI-Skip-Response")) {
        writeResponse(response, status, headers, body);
    }
}

function writeResponse(servletResponse, status, headers, body) {
    servletResponse.setStatus(status);
    writeHeaders(servletResponse, headers);
    var charset = getMimeParameter(headers.get("Content-Type"), "charset");
    writeBody(servletResponse, body, charset);
}

function writeHeaders(servletResponse, headers) {
    for (var key in headers) {
        var values = headers[key];
        if (typeof values === "string") {
            values = values.split("\n");
        } else if (!Array.isArray(values)) {
            continue;
        }
        values.forEach(function(value) {
            servletResponse.addHeader(key, value);
        });
    }
}

function writeBody(response, body, charset) {
    if (body && typeof body.forEach == "function") {
        var output = response.getOutputStream();
        var writer = function(part) {
            if (!(part instanceof Binary)) {
                part = part.toByteString(charset);
            }
            output.write(part);
        };
        body.forEach(writer);
        if (typeof body.close == "function") {
            body.close(writer);
        }
    } else {
        throw new Error("Response body doesn't implement forEach: " + body);
    }
}

/**
 * Creates a streaming asynchronous response. The returned response object can be used
 * both synchronously from the current thread or asynchronously from another thread,
 * even after the original thread has finished execution. AsyncResponse objects are
 * threadsafe.
 * @param {Object} request the JSGI request object
 * @param {Number} timeout the response timeout in milliseconds. Defaults to 30 seconds.
 * @param {Boolean} autoFlush whether to flush after each write.
 */
function AsyncResponse(request, timeout, autoFlush) {
    if (!request || !request.env) {
        throw new Error("Invalid request argument: " + request);
    }
    var {servletRequest, servletResponse} = request.env;
    var asyncContext = servletRequest.startAsync();
    if (timeout != null && isFinite(timeout)) {
        asyncContext.setTimeout(timeout);
    }
    asyncContext.addListener(new AsyncListener({
        "onComplete": function(event) {
            log.debug("AsyncListener.onComplete", event);
        },
        "onError": function(event) {
            log.debug("AsyncListener.onError", event);
        },
        "onStartAsync": function(event) {
            log.debug("AsyncListener.onStartAsync", event);
        },
        "onTimeout": function(event) {
            log.debug("AsyncListener.onTimeout", event);
            asyncContext.complete();
        }
    }));

    var out = servletResponse.getOutputStream();
    var writeListener = null;
    return {
        "start": function(status, headers) {
            servletResponse.setStatus(status);
            writeHeaders(servletResponse, headers || {});
            return this;
        },
        "write": function(data, encoding) {
            data = (data instanceof Binary) ? data : String(data).toByteArray(encoding);
            if (writeListener === null) {
                writeListener = new WriteListenerImpl(asyncContext,
                        autoFlush === true);
                writeListener.queue.add(data);
                out.setWriteListener(writeListener);
            } else {
                writeListener.queue.add(data);
                writeListener.onWritePossible();
            }
            return this;
        },
        "flush": function() {
            if (out.isReady()) {
                out.flush();
            }
        },
        "close": function() {
            asyncContext.complete();
        }
    };
}

/**
 * Convenience function that resolves a module id or object to a
 * JSGI middleware or application function. This assumes the function is
 * exported as "middleware" or "handleRequest".
 * @param {Function|Object|String|Array} app a function, module object, module id, or an array of
 *            any of these
 * @returns {Function} the resolved middleware function
 */
function resolve(app) {
    if (typeof app == 'string') {
        var module = require(app);
        return module.middleware || module.handleRequest;
    } else if (Array.isArray(app)) {
        // allow an app or middleware item to be itself a list of middlewares
        return app.reduceRight(middlewareWrapper);
    }
    return app;
}

/**
 * Helper function for wrapping middleware stacks
 * @param {Object|Function} inner an app or middleware module or function wrapped by outer
 * @param {Object|Function} outer a middleware module or function wrapping inner
 * @returns {Function} the wrapped middleware function
 */
function middlewareWrapper(inner, outer) {
    return resolve(outer)(inner);
}

/**
 * Creates a new WriteListener instance
 * @param {javax.servlet.AsyncContext} asyncContext The async context of the request
 * @param {javax.servlet.ServletOutputStream} outStream The output stream to write to
 * @param {boolean} autoFlush If true flush after every write to the output stream
 * @returns {javax.servlet.WriteListener}
 * @constructor
 */
var WriteListenerImpl = function(asyncContext, autoFlush) {
    this.queue = new ConcurrentLinkedQueue();
    this.asyncContext = asyncContext;
    this.autoFlush = autoFlush === true;
    return new WriteListener(this);
};

/**
 * Called by the servlet container or directly. Polls all byte arrays from
 * the internal queue and writes the to the response's output stream, possibly
 * flushing after each write (if the constructor's `autoFlush` argument is true)
 */
WriteListenerImpl.prototype.onWritePossible = function() {
    var outStream = this.asyncContext.getResponse().getOutputStream();
    while (!this.queue.isEmpty() && outStream.isReady()) {
        var data = this.queue.poll();
        if (!data) {
            break;
        }
        outStream.write(data);
    }
    if (this.autoFlush === true && outStream.isReady()) {
        outStream.flush();
    }
};

/**
 * Called on every write listener error
 * @param {java.lang.Throwable} error The error
 */
WriteListenerImpl.prototype.onError = function(error) {
    log.error("WriteListener.onError", error);
    error.printStackTrace();
    this.asyncContext.complete();
};
