import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";

export const ISOLATED_TEST_MARKERS = Object.freeze(["TESTNET","NO REAL-WORLD VALUE","NO LEGAL EFFECT"]);
const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0+$/i;
const FROZEN = "0xec7d57e6f91fe1d1ee1ec0cb1df8e869088de104";
const DESCRIPTION = ISOLATED_TEST_MARKERS.join(" | ") + ". Separately AI-generated abstract technical payload for Ethereum Hoodi. No association with real charitable donations, receipts, physical title, redemption, valuation, artist identity or holder benefits.";
const sha256 = data => createHash("sha256").update(data).digest("hex");
function check(value, code) { if(!value) throw new Error(code); }
function keys(value, expected, code) {
  check(value && typeof value === "object" && !Array.isArray(value), code);
  check(Object.keys(value).sort().join(",") === [...expected].sort().join(","), code);
}
function markers(value) {
  return Array.isArray(value) && value.length === 3 && ISOLATED_TEST_MARKERS.every(x=>value.includes(x));
}
function address(value) { return typeof value==="string" && ADDRESS.test(value) && !ZERO.test(value); }
function hash32(value) { return typeof value==="string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !ZERO.test(value); }
function inside(root, file) {
  const r=relative(root,file);
  return r!=="" && !isAbsolute(r) && r!==".." && !r.startsWith(".."+sep);
}
async function reader(directory) {
  const root=resolve(directory), stat=await lstat(root);
  check(stat.isDirectory() && !stat.isSymbolicLink(),"INPUT_ROOT_INVALID");
  const canonical=await realpath(root);
  return async (name, maximum) => {
    check(typeof name==="string" && /^[A-Za-z0-9_./-]+$/.test(name) &&
      !name.split("/").some(x=>!x || x==="." || x==="..") && !isAbsolute(name),"INPUT_PATH_INVALID");
    let current=canonical;
    for(const part of name.split("/")) {
      current=join(current,part); const partStat=await lstat(current);
      check(!partStat.isSymbolicLink(),"INPUT_SYMLINK_REFUSED");
    }
    const path=await realpath(current);
    check(inside(canonical,path),"INPUT_PATH_ESCAPE");
    const handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before=await handle.stat();
      check(before.isFile() && before.size>0 && before.size<=maximum,"INPUT_SIZE_INVALID");
      const data=await handle.readFile();
      const after=await handle.stat();
      check(data.length===before.size && before.size===after.size && before.ino===after.ino &&
        before.dev===after.dev && before.mtimeMs===after.mtimeMs && before.ctimeMs===after.ctimeMs &&
        await realpath(current)===path,"INPUT_CHANGED_DURING_READ");
      return { data, bytes:data.length, sha256:sha256(data) };
    } finally { await handle.close(); }
  };
}
function json(bytes) {
  check(!bytes.subarray(0,3).equals(Buffer.from("efbbbf","hex")),"INPUT_JSON_BOM_REFUSED");
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
}
function pngHeader(data, asset) {
  check(data.length>=33 && data.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")) &&
    data.readUInt32BE(8)===13 && data.subarray(12,16).toString("ascii")==="IHDR","INPUT_PNG_HEADER_INVALID");
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  check(Number.isInteger(asset.width) && Number.isInteger(asset.height) &&
    width===asset.width && height===asset.height && width>=1 && height>=1 &&
    width<=8192 && height<=8192 && width*height<=16777216 &&
    [1,2,4,8,16].includes(data[24]) && [0,2,3,4,6].includes(data[25]) &&
    data[26]===0 && data[27]===0 && [0,1].includes(data[28]),"INPUT_PNG_DIMENSIONS_INVALID");
  // Header/MIME check only: no claim to decode pixels, verify PNG CRCs or prove AI provenance.
}
function metadata(data, asset) {
  const m=json(data);
  keys(m,["name","description","testAssetMarkers","attributes","properties"],"INPUT_METADATA_FIELDS_INVALID");
  check(m.name===asset.id+" isolated AI test series" && m.description===DESCRIPTION &&
    markers(m.testAssetMarkers),"INPUT_METADATA_MARKERS_INVALID");
  const expectedAttributes=[["Environment","Hoodi 560048"],["Purpose","Isolated technical validation"],["Asset ID",asset.id]];
  check(Array.isArray(m.attributes) && m.attributes.length===3,"INPUT_METADATA_ATTRIBUTES_INVALID");
  m.attributes.forEach((a,i)=>{
    keys(a,["trait_type","value"],"INPUT_METADATA_ATTRIBUTES_INVALID");
    check(a.trait_type===expectedAttributes[i][0] && a.value===expectedAttributes[i][1],"INPUT_METADATA_ATTRIBUTES_INVALID");
  });
  keys(m.properties,["chainId","sourceContentSha256","publicArtworkPreview","publicArtworkUri",
    "holderPreview","realWorldValue","legalEffect"],"INPUT_METADATA_PROPERTIES_INVALID");
  check(m.properties.chainId===560048 && m.properties.sourceContentSha256===asset.sha256 &&
    m.properties.publicArtworkPreview===false && m.properties.publicArtworkUri===null &&
    m.properties.holderPreview===false && m.properties.realWorldValue===false &&
    m.properties.legalEffect===false,"INPUT_METADATA_POLICY_INVALID");
}
function manifest(raw) {
  keys(raw,["schema","namespace","chainId","testAssetMarkers","status","sourceArtVisibility",
    "generationTool","generationEventTimestamps","imageInspection","artworks","deployment",
    "acceptance","boundaries","sourceDependencies"],"INPUT_MANIFEST_FIELDS_INVALID");
  check(raw.schema==="artfi-private-isolated-ai-input/v1" && raw.chainId===560048 &&
    typeof raw.namespace==="string" && /^TESTNET-AI-HOODI-[A-Z0-9-]{1,64}$/.test(raw.namespace) &&
    markers(raw.testAssetMarkers) && raw.status==="GENERATED_INPUTS_ONLY_NOT_DEPLOYED" &&
    raw.sourceArtVisibility==="PRIVATE_TEST_INPUT_NO_PUBLIC_ARTWORK_PREVIEW" &&
    raw.generationTool==="built-in image_gen","INPUT_ISOLATION_INVALID");
  keys(raw.deployment,["status","collectionAddress","adminSafeAddress","transactionHash","description","testAssetMarkers"],"INPUT_DEPLOYMENT_FIELDS_INVALID");
  check(raw.deployment.status==="NOT_DEPLOYED" && raw.deployment.collectionAddress===null &&
    raw.deployment.adminSafeAddress===null && raw.deployment.transactionHash===null &&
    typeof raw.deployment.description==="string" &&
    ISOLATED_TEST_MARKERS.every(x=>raw.deployment.description.includes(x)) &&
    markers(raw.deployment.testAssetMarkers),"INPUT_DEPLOYMENT_CLAIM_REFUSED");
  keys(raw.acceptance,["filesGenerated","bytesCopiedAndHashed","metadataPublication",
    "independentAssetVerification","holderGatedDelivery","UIRuntime","atomicBatch","vault",
    "fractionalization","DAO","marketplace","wholeProduct"],"INPUT_ACCEPTANCE_FIELDS_INVALID");
  check(raw.acceptance.filesGenerated===true && raw.acceptance.bytesCopiedAndHashed===true &&
    Object.entries(raw.acceptance).every(([k,v])=>["filesGenerated","bytesCopiedAndHashed"].includes(k)||v===false),"INPUT_ACCEPTANCE_CLAIM_REFUSED");
  keys(raw.boundaries,["frozenHistoricalRecordsModified","productionManifestInclusion","realArtistReferences",
    "realCchsDocumentsRequired","realValueTransactionsAuthorized","newCredentialsOrResources"],"INPUT_BOUNDARY_FIELDS_INVALID");
  check(Object.values(raw.boundaries).every(x=>x===false),"INPUT_BOUNDARY_VIOLATION");
  check(Array.isArray(raw.artworks) && raw.artworks.length>=2 && raw.artworks.length<=37,"INPUT_BATCH_SIZE_INVALID");
  return raw;
}
function copyBindings(input) {
  let budget=4096;
  const copy=(value,depth)=>{
    check(--budget>=0 && depth<=8,"BINDINGS_JSON_LIMIT");
    if(value===null || typeof value==="boolean")return value;
    if(typeof value==="string"){check(value.length<=4096,"BINDINGS_JSON_LIMIT");return value;}
    if(typeof value==="number"){check(Number.isSafeInteger(value),"BINDINGS_JSON_INVALID");return value;}
    check(value && typeof value==="object","BINDINGS_JSON_INVALID");
    const ds=Object.getOwnPropertyDescriptors(value),ks=Reflect.ownKeys(ds);
    if(Array.isArray(value)){
      check(Object.getPrototypeOf(value)===Array.prototype && ks.length===value.length+1,"BINDINGS_JSON_INVALID");
      return Array.from({length:value.length},(_,i)=>{
        const d=ds[String(i)];check(d && Object.hasOwn(d,"value"),"BINDINGS_JSON_INVALID");
        return copy(d.value,depth+1);
      });
    }
    check(Object.getPrototypeOf(value)===Object.prototype,"BINDINGS_JSON_INVALID");
    return Object.fromEntries(ks.map(k=>{
      const d=ds[k];check(typeof k==="string" && d.enumerable && Object.hasOwn(d,"value"),"BINDINGS_JSON_INVALID");
      return [k,copy(d.value,depth+1)];
    }));
  };
  return copy(input,0);
}
function bind(raw, namespace, items) {
  keys(raw,["schema","namespace","chainId","collection","safe","runtimeCodeHash","safeRuntimeCodeHash","assets"],"BINDINGS_FIELDS_INVALID");
  check(raw.schema==="artfi-isolated-hoodi-bindings/v1" && raw.namespace===namespace &&
    raw.chainId===560048 && address(raw.collection) && address(raw.safe) &&
    raw.collection.toLowerCase()!==raw.safe.toLowerCase() && raw.collection.toLowerCase()!==FROZEN &&
    hash32(raw.runtimeCodeHash) && hash32(raw.safeRuntimeCodeHash),"BINDINGS_IDENTITY_INVALID");
  check(Array.isArray(raw.assets) && raw.assets.length===items.length,"BINDINGS_ASSET_COUNT_INVALID");
  const artworkIds=new Set();
  const inputs=items.map((item,i)=>{
    const a=raw.assets[i];
    keys(a,["id","artworkIdBytes32","metadataURI","metadataSha256","distributionWallet"],"BINDINGS_ASSET_FIELDS_INVALID");
    check(a.id===item.id && hash32(a.artworkIdBytes32) && address(a.distributionWallet) &&
      a.metadataSha256===item.metadataSha256,"BINDINGS_ASSET_MISMATCH");
    check(!artworkIds.has(a.artworkIdBytes32.toLowerCase()),"BINDINGS_DUPLICATE_ARTWORK_ID");
    artworkIds.add(a.artworkIdBytes32.toLowerCase());
    check(typeof a.metadataURI==="string" && Buffer.byteLength(a.metadataURI)<=512,"BINDINGS_URI_INVALID");
    const uri=new URL(a.metadataURI);
    check(["https:","ipfs:"].includes(uri.protocol) && uri.hostname && !uri.username && !uri.password &&
      !uri.search && !uri.hash && decodeURIComponent(uri.pathname).split("/").includes(namespace) &&
      decodeURIComponent(uri.pathname).endsWith("/"+item.id+".json") &&
      !/UNIT-A|ye-yongrun/i.test(decodeURIComponent(a.metadataURI)),"BINDINGS_URI_INVALID");
    return {artworkId:a.artworkIdBytes32,masterArtworkHash:"0x"+item.masterSha256,
      metadataHash:"0x"+item.metadataSha256,distributionWallet:a.distributionWallet,metadataURI:a.metadataURI};
  });
  return { collection:raw.collection,safe:raw.safe,runtimeCodeHash:raw.runtimeCodeHash,
    safeRuntimeCodeHash:raw.safeRuntimeCodeHash,inputs };
}

/** Offline input preparation only. No URLs fetched, credentials loaded, keys created or tx sent.
 * Source images are private; output contains only identities/hashes and optional supplied arguments.
 */
export async function prepareIsolatedHoodiCharity(directory, existingBindings) {
  const fixedBindings=existingBindings===undefined?undefined:copyBindings(existingBindings);
  const read=await reader(directory), manifestFile=await read("input-manifest.json",65536);
  const m=manifest(json(manifestFile.data)), ids=new Set(), contents=new Set(), items=[];
  for(const a of m.artworks) {
    keys(a,["id","relativePath","bytes","sha256","mimeType","width","height","metadataFile",
      "editionsPerSeries","artworkIdBytes32","artworkIdEncodingStatus","holderSpecificDerivativeStatus","publicMetadataURI"],"INPUT_ARTWORK_FIELDS_INVALID");
    check(typeof a.id==="string" && /^TESTNET-AI-HOODI-[0-9]{3}$/.test(a.id) &&
      !ids.has(a.id) && a.relativePath==="source-art/"+a.id+".png" &&
      a.metadataFile==="metadata/"+a.id+".json" && Number.isSafeInteger(a.bytes) &&
      a.bytes>0 && a.bytes<=10485760 && HASH.test(a.sha256) && a.mimeType==="image/png" &&
      a.editionsPerSeries===100 && a.artworkIdBytes32===null &&
      a.artworkIdEncodingStatus==="USE_EXISTING_APPROVED_PRODUCER_ENCODING_NOT_ASSUMED" &&
      a.holderSpecificDerivativeStatus==="NOT_PREPARED" && a.publicMetadataURI===null,"INPUT_ARTWORK_POLICY_INVALID");
    ids.add(a.id);
    const art=await read(a.relativePath,10485760);
    check(art.bytes===a.bytes && art.sha256===a.sha256 && !contents.has(art.sha256),"INPUT_ARTWORK_HASH_MISMATCH");
    contents.add(art.sha256); pngHeader(art.data,a);
    const meta=await read(a.metadataFile,65536); metadata(meta.data,a);
    items.push({id:a.id,masterFile:a.relativePath,masterBytes:art.bytes,masterSha256:art.sha256,
      metadataFile:a.metadataFile,metadataBytes:meta.bytes,metadataSha256:meta.sha256,
      editions:100,width:a.width,height:a.height});
  }
  const supplied=fixedBindings===undefined?null:bind(fixedBindings,m.namespace,items);
  return {
    schema:"artfi-isolated-hoodi-charity-preparation/v1",chainId:560048,namespace:m.namespace,
    testAssetMarkers:[...ISOLATED_TEST_MARKERS],status:"PREPARATION_ONLY",
    inputManifestSha256:manifestFile.sha256,artworkCount:items.length,totalUnits:items.length*100,items,
    suppliedBindings:supplied,
    missingBindings:supplied?[]:["existing collection/Safe/runtime binding","approved producer artwork-ID values","published exact metadata URI/hash and distribution wallet per item"],
    executionEnabled:false,authorization:"NOT_ESTABLISHED",runtimeBindingsObserved:false,
    imagePixelDecodeVerified:false,aiGenerationProvenanceVerified:false,holderDerivativeVerified:false,
    UIAcceptance:false,atomicBatchAcceptance:false,wholeProductAccepted:false,
  };
}

