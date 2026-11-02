import {test} from "node:test";
import assert from "node:assert/strict";
import {handle} from "./worker.mjs";
const origin="https://augustof2022.github.io";
const env={ALLOWED_ORIGIN:origin,CF_TURN_KEY_ID:"example-key",CF_TURN_API_TOKEN:"private-test-token",TURN_RATE_LIMITER:{async limit(){return {success:true};}}};
const request=()=>new Request("https://relay.example/ice",{headers:{Origin:origin,"CF-Connecting-IP":"192.0.2.1"}});
test("returns only expiring ICE credentials; API secrets stay on the server", async()=>{
  const response=await handle(request(),env,async(url,options)=>{
    assert.ok(url.endsWith("/example-key/credentials/generate-ice-servers"));
    assert.equal(options.headers.Authorization,"Bearer private-test-token");
    assert.equal(JSON.parse(options.body).ttl,86400);
    return Response.json({iceServers:[{urls:["turns:turn.example:443?transport=tcp","turn:turn.example:53"],username:"temporary",credential:"temporary-password"}],secret:"must-not-leak"});
  });
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),origin);
  const text=await response.text();
  assert.equal(text.includes("private-test-token"),false);
  assert.equal(text.includes("must-not-leak"),false);
  assert.deepEqual(JSON.parse(text).iceServers[0].urls,["turns:turn.example:443?transport=tcp"]);
});
test("denies other origins, unconfigured secrets, rate limits and provider failures",async()=>{
  const never=()=>{throw new Error("unexpected upstream request");};
  assert.equal((await handle(new Request("https://relay.example/ice"),env,never)).status,403);
  assert.equal((await handle(request(),{...env,CF_TURN_API_TOKEN:""},never)).status,503);
  assert.equal((await handle(request(),{...env,TURN_RATE_LIMITER:{async limit(){return {success:false};}}},never)).status,429);
  assert.equal((await handle(request(),env,async()=>new Response("provider secret detail",{status:401}))).status,502);
});
