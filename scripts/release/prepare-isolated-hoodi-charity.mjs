import { constants, openSync, fstatSync, readFileSync, closeSync, lstatSync } from "node:fs";
import { prepareIsolatedHoodiCharity } from "./lib/isolated-hoodi-payload.mjs";
const [directory, flag, bindingPath, ...extra]=process.argv.slice(2);
if(!directory || extra.length || (flag!==undefined && (flag!=="--bindings" || !bindingPath)) ||
  (flag===undefined && bindingPath!==undefined))
  throw new Error("usage: node scripts/release/prepare-isolated-hoodi-charity.mjs <private-input-directory> [--bindings <existing-approved-bindings.json>]");
try {
  let bindings;
  if(bindingPath) {
    if(lstatSync(bindingPath).isSymbolicLink()) throw Error("binding symlink");
    const fd=openSync(bindingPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    let raw;
    try {
      const before=fstatSync(fd);
      if(!before.isFile()||before.size<1||before.size>65536) throw Error("binding size");
      raw=readFileSync(fd);
      const after=fstatSync(fd);
      if(raw.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error("binding changed");
    }finally{closeSync(fd);}
    bindings=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));
  }
  const result=await prepareIsolatedHoodiCharity(directory,bindings);
  process.stdout.write(JSON.stringify(result)+"\n");
} catch {
  process.stderr.write("Isolated Hoodi preparation failed; no publication, transaction or acceptance occurred.\n");
  process.exitCode=1;
}

