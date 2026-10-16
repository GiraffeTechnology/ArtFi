import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareIsolatedHoodiCharity, ISOLATED_TEST_MARKERS } from "../release/lib/isolated-hoodi-payload.mjs";
const sha=data=>createHash("sha256").update(data).digest("hex");
const digest=n=>n.toString(16).padStart(64,"0");
const address=n=>"0x"+n.toString(16).padStart(40,"0");
const description=ISOLATED_TEST_MARKERS.join(" | ")+". Separately AI-generated abstract technical payload for Ethereum Hoodi. No association with real charitable donations, receipts, physical title, redemption, valuation, artist identity or holder benefits.";
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"artfi-hoodi-input-"));
  t.after(async()=>{assert(root.startsWith(join(tmpdir(),"artfi-hoodi-input-")));await rm(root,{recursive:true,force:true});});
  await mkdir(join(root,"source-art"));await mkdir(join(root,"metadata"));
  const m={
    schema:"artfi-private-isolated-ai-input/v1",namespace:"TESTNET-AI-HOODI-FIXTURE",chainId:560048,
    testAssetMarkers:[...ISOLATED_TEST_MARKERS],status:"GENERATED_INPUTS_ONLY_NOT_DEPLOYED",
    sourceArtVisibility:"PRIVATE_TEST_INPUT_NO_PUBLIC_ARTWORK_PREVIEW",generationTool:"built-in image_gen",
    generationEventTimestamps:"SYNTHETIC_FIXTURE",imageInspection:{method:"SYNTHETIC_HEADER_FIXTURE_NOT_ART"},
    artworks:[],deployment:{status:"NOT_DEPLOYED",collectionAddress:null,adminSafeAddress:null,transactionHash:null,
      description:ISOLATED_TEST_MARKERS.join(" | "),testAssetMarkers:[...ISOLATED_TEST_MARKERS]},
    acceptance:{filesGenerated:true,bytesCopiedAndHashed:true,metadataPublication:false,independentAssetVerification:false,
      holderGatedDelivery:false,UIRuntime:false,atomicBatch:false,vault:false,fractionalization:false,DAO:false,marketplace:false,wholeProduct:false},
    boundaries:{frozenHistoricalRecordsModified:false,productionManifestInclusion:false,realArtistReferences:false,
      realCchsDocumentsRequired:false,realValueTransactionsAuthorized:false,newCredentialsOrResources:false},
    sourceDependencies:{},
  };
  // Artificial header-only bytes exercise signature/dimension checks; not decoded PNGs or AI art.
  for(let i=1;i<=2;i++) {
    const id="TESTNET-AI-HOODI-"+String(i).padStart(3,"0"),data=Buffer.alloc(34);
    Buffer.from("89504e470d0a1a0a","hex").copy(data);data.writeUInt32BE(13,8);data.write("IHDR",12);
    data.writeUInt32BE(16,16);data.writeUInt32BE(16,20);data[24]=8;data[25]=2;data[33]=i;
    const a={id,relativePath:"source-art/"+id+".png",bytes:data.length,sha256:sha(data),
      mimeType:"image/png",width:16,height:16,metadataFile:"metadata/"+id+".json",editionsPerSeries:100,
      artworkIdBytes32:null,artworkIdEncodingStatus:"USE_EXISTING_APPROVED_PRODUCER_ENCODING_NOT_ASSUMED",
      holderSpecificDerivativeStatus:"NOT_PREPARED",publicMetadataURI:null};
    m.artworks.push(a);await writeFile(join(root,a.relativePath),data);
    await writeFile(join(root,a.metadataFile),JSON.stringify({
      name:id+" isolated AI test series",description,testAssetMarkers:[...ISOLATED_TEST_MARKERS],
      attributes:[{trait_type:"Environment",value:"Hoodi 560048"},{trait_type:"Purpose",value:"Isolated technical validation"},{trait_type:"Asset ID",value:id}],
      properties:{chainId:560048,sourceContentSha256:a.sha256,publicArtworkPreview:false,publicArtworkUri:null,
        holderPreview:false,realWorldValue:false,legalEffect:false},
    }));
  }
  const save=()=>writeFile(join(root,"input-manifest.json"),JSON.stringify(m));
  const changeMetadata=async(fn)=>{const path=join(root,m.artworks[0].metadataFile);const x=JSON.parse(await readFile(path,"utf8"));fn(x);await writeFile(path,JSON.stringify(x));};
  await save();
  return {root,m,save,changeMetadata};
}
async function bindings(f) {
  return {schema:"artfi-isolated-hoodi-bindings/v1",namespace:f.m.namespace,chainId:560048,
    collection:address(10),safe:address(11),runtimeCodeHash:"0x"+digest(12),safeRuntimeCodeHash:"0x"+digest(13),
    assets:await Promise.all(f.m.artworks.map(async(a,i)=>({id:a.id,artworkIdBytes32:"0x"+digest(100+i),
      metadataURI:"https://test.invalid/"+f.m.namespace+"/"+a.id+".json",
      metadataSha256:sha(await readFile(join(f.root,a.metadataFile))),distributionWallet:address(20)}))),
  };
}
test("prepares two exact private byte inputs without inventing bindings or provenance",async t=>{
  const f=await fixture(t),r=await prepareIsolatedHoodiCharity(f.root);
  assert.equal(r.artworkCount,2);assert.equal(r.totalUnits,200);assert.equal(r.status,"PREPARATION_ONLY");
  assert.equal(r.suppliedBindings,null);assert(r.missingBindings.length>0);
  for(const flag of ["executionEnabled","runtimeBindingsObserved","imagePixelDecodeVerified","aiGenerationProvenanceVerified","holderDerivativeVerified","UIAcceptance","atomicBatchAcceptance","wholeProductAccepted"])assert.equal(r[flag],false);
  assert.equal(r.authorization,"NOT_ESTABLISHED");assert.equal(r.items[0].masterSha256,f.m.artworks[0].sha256);
});
test("supplied approved values prepare exact ABI fields without execution readiness",async t=>{
  const f=await fixture(t),b=await bindings(f),r=await prepareIsolatedHoodiCharity(f.root,b);
  assert.equal(r.suppliedBindings.inputs.length,2);assert.equal(r.suppliedBindings.inputs[0].artworkId,b.assets[0].artworkIdBytes32);
  assert.equal(r.suppliedBindings.inputs[0].masterArtworkHash,"0x"+f.m.artworks[0].sha256);
  assert.equal(r.suppliedBindings.inputs[0].metadataHash,"0x"+b.assets[0].metadataSha256);
  assert.deepEqual(r.missingBindings,[]);assert.equal(r.executionEnabled,false);assert.equal(r.runtimeBindingsObserved,false);
});
test("rejects Sepolia and production declarations",async t=>{
  const f=await fixture(t);f.m.chainId=11155111;await f.save();await assert.rejects(prepareIsolatedHoodiCharity(f.root),/ISOLATION/);
  f.m.chainId=560048;f.m.boundaries.productionManifestInclusion=true;await f.save();await assert.rejects(prepareIsolatedHoodiCharity(f.root),/BOUNDARY/);
});
test("rejects missing and duplicate test labels",async t=>{
  const f=await fixture(t);f.m.testAssetMarkers=["TESTNET","TESTNET","NO LEGAL EFFECT"];await f.save();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/ISOLATION/);
});
test("rejects historical artwork identifiers",async t=>{
  const f=await fixture(t);f.m.artworks[0].id="UNIT-A01";await f.save();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/ARTWORK_POLICY/);
});
test("rejects one-item input and too many artworks for this atomic-batch profile",async t=>{
  const f=await fixture(t);f.m.artworks=f.m.artworks.slice(0,1);await f.save();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/BATCH_SIZE/);
  f.m.artworks=Array(38).fill(f.m.artworks[0]);await f.save();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/BATCH_SIZE/);
});
test("rejects a claimed deployment or acceptance",async t=>{
  const f=await fixture(t);f.m.deployment.collectionAddress=address(10);await f.save();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/DEPLOYMENT_CLAIM/);
  f.m.deployment.collectionAddress=null;f.m.acceptance.atomicBatch=true;await f.save();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/ACCEPTANCE_CLAIM/);
});
test("does not require or admit real CCHS documents into isolated inputs",async t=>{
  const f=await fixture(t);f.m.boundaries.realCchsDocumentsRequired=true;await f.save();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/BOUNDARY/);
});
test("rejects changed image bytes",async t=>{
  const f=await fixture(t);await writeFile(join(f.root,f.m.artworks[0].relativePath),Buffer.alloc(34));
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/HASH_MISMATCH/);
});
test("rejects duplicate source content even with different identifiers",async t=>{
  const f=await fixture(t),a=f.m.artworks[0],b=f.m.artworks[1];
  const data=await readFile(join(f.root,a.relativePath));await writeFile(join(f.root,b.relativePath),data);
  b.sha256=a.sha256;b.bytes=a.bytes;await f.save();await assert.rejects(prepareIsolatedHoodiCharity(f.root),/HASH_MISMATCH/);
});
test("rejects declared dimensions that do not match PNG IHDR",async t=>{
  const f=await fixture(t);f.m.artworks[0].width=17;await f.save();await assert.rejects(prepareIsolatedHoodiCharity(f.root),/DIMENSIONS/);
});
test("rejects a non-PNG header despite matching file digest",async t=>{
  const f=await fixture(t),a=f.m.artworks[0],b=Buffer.alloc(34);a.sha256=sha(b);
  await writeFile(join(f.root,a.relativePath),b);await f.save();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/PNG_HEADER/);
});
test("rejects traversal, absolute and wrong-namespace source paths",async t=>{
  const f=await fixture(t);
  for(const path of ["../outside.png","/outside.png","source-art/UNIT-A01.png"]) {
    f.m.artworks[0].relativePath=path;await f.save();await assert.rejects(prepareIsolatedHoodiCharity(f.root),/ARTWORK_POLICY/);
  }
});
test("rejects a symlink to another input file",async t=>{
  const f=await fixture(t),first=join(f.root,f.m.artworks[0].relativePath);
  await rm(first);await symlink(join(f.root,f.m.artworks[1].relativePath),first);
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/SYMLINK/);
});
test("rejects oversized input manifest before JSON parsing",async t=>{
  const f=await fixture(t);await writeFile(join(f.root,"input-manifest.json")," ".repeat(65537));
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/SIZE/);
});
test("rejects malformed UTF-8 and BOM metadata",async t=>{
  const f=await fixture(t),p=join(f.root,f.m.artworks[0].metadataFile),original=await readFile(p);
  await writeFile(p,Buffer.from([0xc3,0x28]));await assert.rejects(prepareIsolatedHoodiCharity(f.root));
  await writeFile(p,Buffer.concat([Buffer.from("efbbbf","hex"),original]));await assert.rejects(prepareIsolatedHoodiCharity(f.root),/BOM/);
});
test("rejects a public artwork preview property",async t=>{
  const f=await fixture(t);await f.changeMetadata(m=>{m.image="https://test.invalid/master.png";});
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/METADATA_FIELDS/);
});
test("rejects non-isolated metadata chain and real-value claims",async t=>{
  const f=await fixture(t);await f.changeMetadata(m=>{m.properties.chainId=11155111;});
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/METADATA_POLICY/);
  await f.changeMetadata(m=>{m.properties.chainId=560048;m.properties.realWorldValue=true;});
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/METADATA_POLICY/);
});
test("rejects mismatched metadata-to-master hashes",async t=>{
  const f=await fixture(t);await f.changeMetadata(m=>{m.properties.sourceContentSha256=digest(999);});
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/METADATA_POLICY/);
});
test("rejects substituted positive fundraising or artist text",async t=>{
  const f=await fixture(t);await f.changeMetadata(m=>{m.description="Real charity receipt for physical artwork";});
  await assert.rejects(prepareIsolatedHoodiCharity(f.root),/METADATA_MARKERS/);
});
test("accepts semantic attribute fields regardless of object key insertion order",async t=>{
  const f=await fixture(t);await f.changeMetadata(m=>{m.attributes=m.attributes.map(a=>({value:a.value,trait_type:a.trait_type}));});
  const r=await prepareIsolatedHoodiCharity(f.root);assert.equal(r.artworkCount,2);
});
test("rejects withdrawn/frozen collection even in purported Hoodi bindings",async t=>{
  const f=await fixture(t),b=await bindings(f);b.collection="0xec7d57e6f91fe1d1eE1eC0cb1dF8E869088de104";
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/BINDINGS_IDENTITY/);
});
test("rejects stale published metadata digest",async t=>{
  const f=await fixture(t),b=await bindings(f);b.assets[0].metadataSha256=digest(999);
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/ASSET_MISMATCH/);
});
test("rejects reordering or missing one asset binding",async t=>{
  const f=await fixture(t),b=await bindings(f);b.assets.reverse();
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/ASSET_MISMATCH/);
  b.assets.pop();await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/ASSET_COUNT/);
});
test("rejects duplicate approved artwork IDs",async t=>{
  const f=await fixture(t),b=await bindings(f);b.assets[1].artworkIdBytes32=b.assets[0].artworkIdBytes32;
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/DUPLICATE_ARTWORK/);
});
test("rejects a publication URI outside the isolated namespace",async t=>{
  const f=await fixture(t),b=await bindings(f);b.assets[0].metadataURI="https://test.invalid/ye-yongrun/UNIT-A01.json";
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/URI_INVALID/);
});
test("rejects URI credentials, queries and remote plaintext URLs",async t=>{
  const f=await fixture(t),b=await bindings(f);
  for(const uri of ["https://user:secret@test.invalid/"+f.m.namespace+"/x","https://test.invalid/"+f.m.namespace+"/x?q=1","http://test.invalid/"+f.m.namespace+"/x"]) {
    b.assets[0].metadataURI=uri;await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/URI_INVALID/);
  }
});
test("copies supplied bindings before filesystem awaits",async t=>{
  const f=await fixture(t),b=await bindings(f),original=b.assets[0].metadataSha256;
  const pending=prepareIsolatedHoodiCharity(f.root,b);b.assets[0].metadataSha256=digest(999);
  const r=await pending;assert.equal(r.suppliedBindings.inputs[0].metadataHash,"0x"+original);
});
test("refuses binding accessors without invoking them",async t=>{
  const f=await fixture(t),b=await bindings(f);let invoked=false;
  Object.defineProperty(b,"collection",{get(){invoked=true;return address(10);},enumerable:true});
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/BINDINGS_JSON_INVALID/);assert.equal(invoked,false);
});
test("binds each metadata URI to its own exact artwork filename",async t=>{
  const f=await fixture(t),b=await bindings(f);b.assets[0].metadataURI=b.assets[1].metadataURI;
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/URI_INVALID/);
});
test("refuses zero recipient and zero runtime commitments",async t=>{
  const f=await fixture(t),b=await bindings(f);b.runtimeCodeHash="0x"+digest(0);
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/IDENTITY/);
  b.runtimeCodeHash="0x"+digest(12);b.assets[0].distributionWallet=address(0);
  await assert.rejects(prepareIsolatedHoodiCharity(f.root,b),/ASSET_MISMATCH/);
});

