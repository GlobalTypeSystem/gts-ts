'use strict';
// Standalone-sink look-alikes that the scan must stay silent about.
const Prefilter = { eval: (x) => x };
const obj = { eval: (x) => x };
const api = { fetch: (x) => x };
const queue = { sendBeacon: (x) => x };
const pool = { importScripts: (x) => x };
const isFunction = (f) => typeof f === 'function';
const isFetch = (x) => x === 'fetch';

Prefilter.eval(1);
obj.eval(1);
isFunction(obj);
api.fetch('x');
queue.sendBeacon('x');
pool.importScripts('x');
isFetch('x');

// eval('1') in a line comment
/* new Function('return 1') and fetch('/x') in a block comment,
   plus new Worker('w.js') on a second line */
const text = 'eval(1) new Function fetch( new Worker( inside a string';
const tpl = `template mentions eval(1) and ${text.length} new Function`;
const re = /eval\(|"fetch\(/;
module.exports = { Prefilter, obj, api, queue, pool, isFunction, isFetch, text, tpl, re };
class Matcher {
  eval(input, pos) {
    return input + pos;
  }
}
