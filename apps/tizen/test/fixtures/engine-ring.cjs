const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const core = require(process.argv[2]);
const data = Buffer.from('cebola-test-data');
function b(v) {
 if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(v.length+':'),v]);
 if (typeof v === 'string') return b(Buffer.from(v));
 if (typeof v === 'number') return Buffer.from('i'+v+'e');
 return Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[b(k),b(v[k])]),Buffer.from('e')]);
}
const info={length:data.length,name:'test.mkv','piece length':16384,pieces:crypto.createHash('sha1').update(data).digest()};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cebola-ring-'));
const deadline=setTimeout(()=>{console.error('timeout');process.exit(1)},8000);
const engine=core.engine(b({info}),{path:root,buffer:16*1024*1024,circularBuffer:{type:'memory',size:48*1024*1024},uploads:0});
engine.on('error',err=>{console.error(err.message);process.exit(1)});
engine.ready(()=>{
 engine.store.write(0,data);
 engine.store.commit(0,0,()=>{
  engine.bitfield.set(0,true);engine.pieces[0]=null;
  const output=[];const reader=engine.files[0].createReadStream({start:0,end:data.length-1});
  reader.on('data',chunk=>output.push(chunk));reader.on('end',()=>{
   if(!Buffer.concat(output).equals(data))throw Error('bad bytes');
   engine.destroy(()=>{fs.rmSync(root,{recursive:true,force:true});clearTimeout(deadline);console.log('EngineFS real: buffer circular e leitura de bytes aprovados');process.exit(0)});
  });
 });
});
