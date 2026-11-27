import { buildAuthTestApp as buildApp, registrationPayload } from '../test-support/identity-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

import { migrate, postgres } from '../src/db.js';
import { createRealtimeBindings } from '../src/realtime-provider.js';
import { provisionCredits } from '../src/wallet.js';

// This optional transport test uses isolated headless peers and generated tones.
// It needs an installed Chrome and a path to a Playwright installation.
const playwrightPath = process.env.FAI_TEST_PLAYWRIGHT_PATH;

async function preparePeer(page, frequency) {
  await page.evaluate(async hz => {
    const rtc = new RTCPeerConnection({iceServers:[]});
    const audio = new AudioContext();
    await audio.resume();
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    volume.gain.value = 0.2;
    oscillator.frequency.value = hz;
    const microphone = audio.createMediaStreamDestination();
    oscillator.connect(volume).connect(microphone);
    oscillator.start();
    rtc.addTrack(microphone.stream.getAudioTracks()[0],microphone.stream);
    const spectrum = audio.createAnalyser();
    spectrum.fftSize = 2048;
    const mute = audio.createGain();
    mute.gain.value = 0;
    spectrum.connect(mute).connect(audio.destination);
    rtc.ontrack = event => {
      // Chromium starts its remote audio renderer when a media element consumes
      // the track, just as the workbench player will. The test browser is muted.
      const player = document.createElement('audio');
      player.autoplay = true;
      player.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      document.body.append(player);
      player.play().catch(error => { window.playbackError = error.name; });
      const remote = audio.createMediaStreamSource(player.srcObject);
      remote.connect(spectrum);
      window.inputNode = remote;
    };
    function channelReady(channel) {
      window.events = channel;
      channel.onmessage = event => window.lastMessage = event.data;
    }
    rtc.ondatachannel = event => channelReady(event.channel);
    window.localOffer = async () => {
      channelReady(rtc.createDataChannel('oai-events'));
      await rtc.setLocalDescription(await rtc.createOffer());
      return gathered();
    };
    window.answerOffer = async sdp => {
      await rtc.setRemoteDescription({type:'offer',sdp});
      await rtc.setLocalDescription(await rtc.createAnswer());
      return gathered();
    };
    async function gathered() {
      if (rtc.iceGatheringState !== 'complete') await new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('Local ICE gathering timed out')),8000);
        const done = () => {
          if (rtc.iceGatheringState !== 'complete') return;
          clearTimeout(timer); rtc.removeEventListener('icegatheringstatechange',done); resolve();
        };
        rtc.addEventListener('icegatheringstatechange',done);
      });
      return rtc.localDescription.sdp;
    }
    window.receivedHz = () => {
      const bins = new Uint8Array(spectrum.frequencyBinCount);
      spectrum.getByteFrequencyData(bins);
      const strongest = Math.max(...bins);
      return strongest > 40 ? bins.indexOf(strongest) * audio.sampleRate / spectrum.fftSize : 0;
    };
    window.rtc = rtc;
  },frequency);
}

test('two WebRTC peers exchange identifiable audio and events through backend signaling',
  {skip:!playwrightPath,timeout:90000},async t => {
    const db = process.env.FAI_TEST_DATABASE_URL ? postgres(process.env.FAI_TEST_DATABASE_URL) : new PGlite();
    const bindings = new Map();
    const app = await buildApp({db,realtimeVoice:bindings});
    app.get('/voice-test-peer',async (_req,reply)=>reply.type('text/html').send('<!doctype html><title>Local voice test peer</title>'));
    let browser, upstream, provider;
    t.after(async () => {
      await browser?.close(); await app.close();
      if (provider) await new Promise(resolve=>provider.close(resolve));
      await db.close();
    });
    await migrate(db);
    const origin=await app.listen({host:'127.0.0.1',port:0});
    browser=await createRequire(import.meta.url)(playwrightPath).chromium.launch({channel:'chrome',headless:true,
      args:['--mute-audio','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
    const [client,peer]=await Promise.all([browser.newPage(),browser.newPage()]);
    upstream=peer;
    await Promise.all([client,peer].map(page=>page.goto(origin+'/voice-test-peer')));
    await Promise.all([preparePeer(client,440),preparePeer(peer,880)]);
    let fixtureError, starts=0, stops=0;
    provider=createServer(async (req,res)=>{
      try {
        if (req.method==='POST' && req.url==='/v1/realtime/calls') {
          starts++;
          const form=await new Response(req,{headers:req.headers}).formData();
          assert.equal(JSON.parse(form.get('session')).model,'local-rtc-fixture');
          const answer=await upstream.evaluate(sdp=>window.answerOffer(sdp),form.get('sdp'));
          res.writeHead(201,{location:'/v1/realtime/calls/rtc_local','content-type':'application/sdp'}); res.end(answer);
        } else if (req.method==='POST' && req.url==='/v1/realtime/calls/rtc_local/hangup') {
          stops++; await upstream.evaluate(()=>rtc.close()); res.writeHead(200); res.end();
        } else { res.writeHead(404); res.end(); }
      } catch(error) { fixtureError=error; res.writeHead(500); res.end(); }
    });
    await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
    const registered=await app.inject({method:'POST',url:'/v1/auth/register',payload:await registrationPayload(app, {type:'personal',displayName:'Voice test',
      email:randomUUID()+'@example.test',password:'synthetic-voice-test'})});
    assert.equal(registered.statusCode,201);
    const member=registered.json(), workspace=member.workspaces[0].id;
    const definition={workspaceId:workspace,model:'local-rtc-fixture',voice:'marin',credits:2,durationSeconds:120,
      baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1'};
    bindings.set(workspace,createRealtimeBindings({REALTIME_VOICE_BINDINGS_JSON:JSON.stringify([definition])}).get(workspace));
    await provisionCredits(db,workspace,member.account.id,2,'rtc-transport-test');
    const url='/v1/voice/realtime/sessions/'+randomUUID();
    const headers={authorization:'Bearer '+member.token,'x-workspace-id':workspace,'content-type':'application/json'};
    const negotiated=await client.evaluate(async ({url,headers})=>{
      const offerSdp=await window.localOffer();
      const response=await fetch(url,{method:'PUT',headers,body:JSON.stringify({offerSdp})});
      const session=await response.json();
      if (session.answerSdp) await rtc.setRemoteDescription({type:'answer',sdp:session.answerSdp});
      return {status:response.status,state:session.state,errorCode:session.errorCode};
    },{url,headers});
    if (fixtureError) throw fixtureError;
    assert.deepEqual(negotiated,{status:201,state:'active',errorCode:null});
    for (const [page,expectedHz] of [[client,880],[peer,440]]) {
      await page.waitForFunction(hz=>rtc.connectionState==='connected' && window.events?.readyState==='open' &&
        Math.abs(window.receivedHz()-hz)<40,expectedHz,{timeout:18000}).catch(async error => {
        const diagnostics=await page.evaluate(async ()=>({connection:rtc.connectionState,ice:rtc.iceConnectionState,
          channel:window.events?.readyState,frequency:window.receivedHz(),playbackError:window.playbackError,
          stats:[...(await rtc.getStats()).values()].filter(s=>['inbound-rtp','outbound-rtp','candidate-pair','media-source'].includes(s.type))
            .map(s=>({type:s.type,state:s.state,received:s.bytesReceived,sent:s.bytesSent,energy:s.totalAudioEnergy}))}));
        throw new Error('Expected '+expectedHz+' Hz: '+JSON.stringify(diagnostics),{cause:error});
      });
      const bytes=await page.evaluate(async ()=>{
        const stats=[...(await rtc.getStats()).values()];
        return [stats.find(x=>x.type==='inbound-rtp' && x.kind==='audio')?.bytesReceived,
          stats.find(x=>x.type==='outbound-rtp' && x.kind==='audio')?.bytesSent];
      });
      assert.ok(bytes.every(n=>n>0),'audio RTP must flow in both directions');
    }
    await client.evaluate(()=>events.send('client-test-event'));
    await peer.waitForFunction(()=>window.lastMessage==='client-test-event');
    await peer.evaluate(()=>events.send('provider-test-event'));
    await client.waitForFunction(()=>window.lastMessage==='provider-test-event');
    const closed=await client.evaluate(async ({url,headers})=>{
      const response=await fetch(url,{method:'DELETE',headers:{authorization:headers.authorization,'x-workspace-id':headers['x-workspace-id']}});
      return (await response.json()).state;
    },{url,headers});
    assert.equal(closed,'closed'); assert.equal(await peer.evaluate(()=>rtc.connectionState),'closed');
    assert.equal(starts,1); assert.equal(stops,1);
  });
