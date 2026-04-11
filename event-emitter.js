/**
 * Minimal event emitter for decoupling game modules.
 */
class EventEmitter {
    constructor() {
        this._listeners = {};
    }
    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }
    off(event, fn) {
        const list = this._listeners[event];
        if (!list) return this;
        this._listeners[event] = list.filter(f => f !== fn);
        return this;
    }
    emit(event, ...args) {
        const list = this._listeners[event];
        if (list) list.forEach(fn => fn(...args));
        return this;
    }
}
