#!/usr/bin/env node
// shrink espeak-ng.wasm to grc-only (no wasm-opt, no meSpeak)
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function readULeb(data, pos) {
  let n=0, shift=0;
  while(true){
    const b=data[pos++];
    n|=(b&0x7F)<<shift;
    if(!(b&0x80)) break;
    shift+=7;
  }
  return [n,pos];
}
function encodeULeb(n){
  const out=[];
  while(true){
    const b=n & 0x7F;
    n>>>=7;
    if(n) out.push(b|0x80); else {out.push(b); break;}
  }
  return Buffer.from(out);
}

const srcPath = process.argv[2] || 'public/espeak-ng.wasm';
const dstPath = process.argv[3] || srcPath;

const data = readFileSync(srcPath);
if (data[0]!==0x00 || data[1]!==0x61 || data[2]!==0x73 || data[3]!==0x6d) throw new Error('not wasm');
let pos=8;
const sections=[];
while(pos < data.length){
  const sid=data[pos++];
  const [sz, p2]=readULeb(data,pos);
  pos=p2;
  const payload=data.subarray(pos,pos+sz);
  sections.push([sid, payload]);
  pos+=sz;
}

// find data and global payloads
let origDataPayload, origGlobalPayload;
for(const [sid,payload] of sections){
  if(sid===11) origDataPayload=payload;
  if(sid===6) origGlobalPayload=payload;
}
if(!origDataPayload) throw new Error('no data section');

let o=0;
let [cnt, p]=readULeb(origDataPayload,0); o=p;
let [flag, p2]=readULeb(origDataPayload,o); o=p2;
if(origDataPayload[o]!==0x41) throw new Error('bad seg0');
o++;
let [v0, p3]=readULeb(origDataPayload,o); o=p3;
if(origDataPayload[o]!==0x0B) throw new Error('bad seg0 end');
o++;
let [segSz, p4]=readULeb(origDataPayload,o); o=p4;
const seg0 = origDataPayload.subarray(o,o+segSz); o+=segSz;
let [flag2, p5]=readULeb(origDataPayload,o); o=p5;
if(origDataPayload[o]!==0x41) throw new Error('bad seg1');
o++;
let [v1, p6]=readULeb(origDataPayload,o); o=p6;
if(origDataPayload[o]!==0x0B) throw new Error('bad seg1 end');
o++;
let [segSz2, p7]=readULeb(origDataPayload,o); o=p7;
const seg1 = origDataPayload.subarray(o,o+segSz2);

const base=0x10000;
const ptrTbl=0x1161b70;
const tblOff=ptrTbl-base;
function leU32(b){ return b[0]|b[1]<<8|b[2]<<16|b[3]<<24; }
function offOf(addr){ return addr-base; }
const tbl=seg0.subarray(tblOff);
const entries=[];
let pp=0;
while(true){
  const na=leU32(tbl.subarray(pp,pp+4));
  if(na===0) break;
  const ln=leU32(tbl.subarray(pp+4,pp+8));
  const ca=leU32(tbl.subarray(pp+8,pp+12));
  entries.push([na,ln,ca]);
  pp+=12;
}
const minOff=Math.min(...entries.map(([na])=>offOf(na)));
const early=seg0.subarray(0,minOff);

const keepSub=["/grc_dict","/lang/grk/grc","/intonations","/phondata","/phondata-manifest","/phonindex","/phontab","/voices/mb/mb-de6-grc"];
const keep=[];
for(const [na,ln,ca] of entries){
  const nameEnd=seg0.indexOf(0, offOf(na));
  const name=seg0.subarray(offOf(na), nameEnd).toString();
  if(keepSub.some(k=>name.includes(k))){
    const nb=Buffer.from(name+'\0');
    const content=seg0.subarray(offOf(ca), offOf(ca)+ln);
    keep.push([nb, content]);
  }
}
if(keep.length!==8) console.warn('keep len', keep.length);

let newSeg=Buffer.from(early);
let cur=newSeg.length;
const tableEntries=[];
for(const [nb,cb] of keep){
  const na=base+cur;
  newSeg=Buffer.concat([newSeg, nb]);
  cur+=nb.length;
  const ca=base+cur;
  newSeg=Buffer.concat([newSeg, cb]);
  cur+=cb.length;
  tableEntries.push([na,cb.length,ca]);
}
const pad=(4-(newSeg.length%4))%4;
if(pad) newSeg=Buffer.concat([newSeg, Buffer.alloc(pad,0)]);
cur+=pad;
const tableAddr=base+cur;
let tableBytes=Buffer.alloc(0);
for(const [na,ln,ca] of tableEntries){
  const b=Buffer.alloc(12);
  b.writeUInt32LE(na,0); b.writeUInt32LE(ln,4); b.writeUInt32LE(ca,8);
  tableBytes=Buffer.concat([tableBytes,b]);
}
tableBytes=Buffer.concat([tableBytes, Buffer.alloc(4,0)]);
newSeg=Buffer.concat([newSeg, tableBytes]);

let newDataPayload=Buffer.concat([
  encodeULeb(2),
  encodeULeb(0), Buffer.from([0x41]), encodeULeb(base), Buffer.from([0x0B]), encodeULeb(newSeg.length), newSeg,
  encodeULeb(0), Buffer.from([0x41]), encodeULeb(v1), Buffer.from([0x0B]), encodeULeb(seg1.length), seg1
]);

// global
let [cntG, oG]=readULeb(origGlobalPayload,0);
let globals=[];
let posG=oG;
for(let i=0;i<cntG;i++){
  const typ=origGlobalPayload[posG++];
  const mut=origGlobalPayload[posG++];
  if(origGlobalPayload[posG]!==0x41) throw new Error('global not i32 const');
  posG++;
  const [val, p8]=readULeb(origGlobalPayload,posG); posG=p8;
  if(origGlobalPayload[posG]!==0x0B) throw new Error('global end');
  posG++;
  globals.push([typ,mut,val]);
}
let newGlobal=Buffer.from(encodeULeb(cntG));
for(let i=0;i<globals.length;i++){
  let [typ,mut,val]=globals[i];
  if(i===77||i===78) val=tableAddr;
  newGlobal=Buffer.concat([newGlobal, Buffer.from([typ,mut,0x41]), encodeULeb(val), Buffer.from([0x0B])]);
}

// rebuild wasm
let out=Buffer.from([0x00,0x61,0x73,0x6D,0x01,0x00,0x00,0x00]);
for(let [sid,payload] of sections){
  if(sid===11) payload=newDataPayload;
  else if(sid===6) payload=newGlobal;
  out=Buffer.concat([out, Buffer.from([sid]), encodeULeb(payload.length), payload]);
}
writeFileSync(dstPath, out);
const origStat=statSync(srcPath);
console.log(`shrink ${srcPath} ${origStat.size} -> ${dstPath} ${out.length} table ${tableAddr.toString(16)}`);
try{
  const {brotliCompressSync, constants}=await import('node:zlib');
  const br=brotliCompressSync(out,{params:{[constants.BROTLI_PARAM_QUALITY]:11}});
  console.log(`br ${br.length} ratio ${(br.length/out.length*100).toFixed(1)}%`);
}catch{}

