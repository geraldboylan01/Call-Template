import assert from 'node:assert/strict';
import { createVideoCapture } from '../js/video_capture.js';
class Track extends EventTarget { constructor(kind){super();this.kind=kind;this.readyState='live';this.enabled=true;} stop(){this.readyState='ended';} end(){this.stop();this.dispatchEvent(new Event('ended'));} }
class Stream {constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}}
class Recorder extends EventTarget {static isTypeSupported(){return true;}constructor(stream,options){super();this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{const e=new Event('dataavailable');e.data=new Blob(['test webm']);this.dispatchEvent(e);this.dispatchEvent(new Event('stop'));});}}
let audio,display;
const mediaDevices={async getUserMedia(){audio=new Track('audio');return new Stream([audio]);},async getDisplayMedia(){display=new Track('video');return new Stream([display]);}};
let latest;
const r=createVideoCapture({mediaDevices,Recorder,Stream,onChange:s=>latest=s});
await assert.rejects(()=>r.start(),/microphone/);
await r.prepare();await r.start();assert.equal(r.recording,true);await assert.rejects(()=>r.prepare(),/Stop recording/);
await r.stop();assert.ok(r.url.startsWith('blob:'));assert.equal(display.readyState,'ended');assert.equal(audio.readyState,'live');
await r.start();display.end();await new Promise(setImmediate);assert.equal(r.recording,false);assert.ok(r.url);
await r.start();audio.end();await new Promise(setImmediate);assert.equal(r.recording,false);assert.match(latest.status,/Microphone disconnected/);
await assert.rejects(()=>r.start(),/microphone/);
await r.prepare();await r.dispose();assert.equal(audio.readyState,'ended');
let release;const pending=createVideoCapture({mediaDevices:{...mediaDevices,getDisplayMedia:()=>new Promise(resolve=>release=resolve)},Recorder,Stream});
await pending.prepare();const started=pending.start();await pending.dispose();const late=new Track('video');release(new Stream([late]));await started;assert.equal(late.readyState,'ended');assert.equal(pending.recording,false);assert.equal(pending.starting,false);
const denied=createVideoCapture({mediaDevices:{...mediaDevices,getDisplayMedia:async()=>{throw new Error('Picker cancelled');}},Recorder,Stream});await denied.prepare();await assert.rejects(()=>denied.start(),/cancelled/);assert.equal(denied.starting,false);await denied.dispose();
let releaseMic;const micPending=createVideoCapture({mediaDevices:{getUserMedia:()=>new Promise(resolve=>releaseMic=resolve)},Recorder,Stream});const preparing=micPending.prepare();await micPending.dispose();const lateMic=new Track('audio');releaseMic(new Stream([lateMic]));await preparing;assert.equal(lateMic.readyState,'ended');
console.log('Shared capture: missing mic, start/stop, WebM finalisation, repeat recording, browser stop-sharing, mic loss, cancelled picker, exit during pending picker and pending microphone all passed (synthetic devices).');
