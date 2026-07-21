/**
 * Compatibility Layer for Node.js 0.8+
 * Local to this package - contains only needed functions.
 */ "use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "tmpdir", {
    enumerable: true,
    get: function() {
        return tmpdir;
    }
});
var _os = /*#__PURE__*/ _interop_require_default(require("os"));
function _interop_require_default(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
function tmpdir() {
    return typeof _os.default.tmpdir === 'function' ? _os.default.tmpdir() : require('os-shim').tmpdir();
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }