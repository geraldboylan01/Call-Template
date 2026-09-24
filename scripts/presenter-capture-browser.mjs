// Native MediaRecorder and WebM encoding, with synthetic canvas + oscillator
// tracks. Does not request the user's camera/microphone or OS capture picker.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
export async function checkNativeCapture() {
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 try {
  const page=await browser.newPage();await page.goto('http://127.0.0.1:8788/');
  const result=await page.evaluate(async()=>{
    const {createVideoCapture,mountVideoCapture}=await import('/js/video_capture.js');
    const audio=new AudioContext();await audio.resume();const oscillator=audio.createOscillator(),destination=audio.createMediaStreamDestination();oscillator.connect(destination);oscillator.start();
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
    const ctx=canvas.getContext('2d');let frame=0;const interval=setInterval(()=>{ctx.fillStyle='#102532';ctx.fillRect(0,0,1280,720);ctx.fillStyle='white';ctx.font='40px sans-serif';ctx.fillText(`Native recording test ${frame++}`,80,100);},40);
    const devices={getUserMedia:async()=>destination.stream,getDisplayMedia:async()=>canvas.captureStream(25)};
    const states=[];const recorder=createVideoCapture({mediaDevices:devices,onChange:s=>states.push({recording:s.recording,starting:s.starting,status:s.status})});
    try {
      await recorder.prepare();await recorder.start();await new Promise(r=>setTimeout(r,1200));await recorder.stop();
      const blob=await (await fetch(recorder.url)).blob();const magic=[...new Uint8Array(await blob.slice(0,4).arrayBuffer())];
      const video=document.createElement('video');video.muted=true;video.src=recorder.url;
      await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=reject;});
      const dimensions={width:video.videoWidth,height:video.videoHeight};
      const host=document.createElement('section');document.body.append(host);let callback;
      const mounted=mountVideoCapture(host,{onRecordingChange:s=>callback=s});await mounted.dispose();
      return {bytes:blob.size,type:blob.type,magic,dimensions,states,callbackIsObject:typeof callback==='object',callbackHasRecording:callback.recording===false};
    } finally {await recorder.dispose();clearInterval(interval);oscillator.stop();await audio.close();}
  });
  assert.ok(result.bytes>1000);assert.deepEqual(result.magic,[26,69,223,163]);assert.deepEqual(result.dimensions,{width:1280,height:720});assert.ok(result.callbackIsObject&&result.callbackHasRecording);
  await page.goto('http://127.0.0.1:8788/private/aam-makeovers/presenter-regression/');
  await page.waitForFunction(()=>window.planeirPresenter?.state().active&&!window.planeirPresenter.state().busy);
  for (const viewport of [{width:1920,height:1080},{width:1280,height:720}]) {
    await page.setViewportSize(viewport);await page.locator('.presenter-camera').evaluate(el=>el.hidden=false);
    const bounds=await page.evaluate(()=>({stage:document.querySelector('#swipeStage').getBoundingClientRect().right,camera:document.querySelector('.presenter-camera').getBoundingClientRect().left}));
    assert.ok(bounds.stage < bounds.camera, 'The camera must not cover the live app');
  }
  result.cameraReserve='No overlap at 1920x1080 and 1280x720';
  console.log(JSON.stringify({status:'passed',test:'Native MediaRecorder with synthetic video and audio; decodable WebM; shared UI callback',...result}));return result;
 } finally {await browser.close();}
}
