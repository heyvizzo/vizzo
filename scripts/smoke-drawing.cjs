// Native drawing regression: real sandboxed preload and input events, no model or microphone calls.
// Run with npm run smoke:drawing. Screenshots are kept in results/drawing-smoke/.
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const project = path.resolve(__dirname, '..');
const artifacts = path.join(project, 'results', 'drawing-smoke');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vizzo-drawing-smoke-')));
let win, drawing=false, submitted=null, previewOpen=false; const ptt=[]; ipcMain.on('ptt',(_,down)=>ptt.push(down));
ipcMain.on('hotkeys:get',e=>{e.returnValue=null;}); // the defaults: Control talks
ipcMain.handle('drawing:get',()=>drawing);
ipcMain.handle('comment:get',()=>false);
ipcMain.handle('page:state',()=>({tFrom:null}));
ipcMain.handle('page:drawing-capture',async e=>(await e.sender.capturePage(undefined,{stayHidden:true})).toDataURL());
ipcMain.on('drawing:mode',(_,on)=>{drawing=on;win.webContents.send('page:drawing-mode',on);});
ipcMain.on('page:drawing-preview',(_,open)=>{previewOpen=open;});
ipcMain.on('page:comment',(_,action)=>{if(action.type==='comment.send')submitted=action;});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn, label){for(let i=0;i<100;i++){const v=await fn();if(v)return v;await pause(40);}throw Error('Timeout: '+label);}
async function main(){
 await app.whenReady();
 win=new BrowserWindow({width:1100,height:760,show:false,webPreferences:{preload:path.join(project,'dist-electron/page-preload.cjs'),sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(_event,...args)=>{if(String(args).includes('failed'))console.error('renderer:',...args);});
 const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:60px;background:#f5f5f7;color:#171a24;font:18px system-ui}h1{font-size:42px;margin:0 0 16px}p{color:#666;max-width:650px}.cards{display:flex;gap:24px;margin-top:48px}article{background:white;border:1px solid #ddd;border-radius:18px;padding:24px;width:240px;height:180px}button{background:#3847ce;color:white;border:0;border-radius:8px;padding:12px 18px;font:inherit}</style><h1>Plan your next release</h1><p>Give the team a clear view of what ships next.</p><div class="cards"><article><h2>Design</h2><p>Review the interface.</p><button>Open design</button></article><article><h2>Engineering</h2><p>Build the next version.</p><button>Open tasks</button></article></div><script>window.pageClicks=0;window.pageKeys=0;window.leaks=[];window.addEventListener('click',e=>{window.pageClicks++;window.leaks.push({x:e.clientX,y:e.clientY,target:e.target.tagName,time:performance.now()})},true);window.addEventListener('keydown',()=>window.pageKeys++,true);</script>`;
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await pause(200);
 win.webContents.debugger.attach('1.3');
 const cdp=(m,p={})=>win.webContents.debugger.sendCommand(m,p);
 async function node(selector){
   const {root}=await cdp('DOM.getDocument',{depth:-1,pierce:true});
   const all=[];const walk=n=>{if(n.shadowRoots)all.push(...n.shadowRoots);for(const ch of [...(n.children||[]),...(n.shadowRoots||[])])walk(ch);};walk(root);
   for(const r of all){const v=await cdp('DOM.querySelector',{nodeId:r.nodeId,selector});if(v.nodeId)return v.nodeId;}
   return null;
 }
 async function call(selector,decl,args=[]){const id=await node(selector);if(!id)throw Error('Missing '+selector);const {object}=await cdp('DOM.resolveNode',{nodeId:id});const r=await cdp('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:decl,arguments:args.map(value=>({value})),returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}
 const settled=()=>win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>resolve()))');
 const click=async(x,y)=>{await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});await settled();};
 async function clickEl(sel){const r=await call(sel,'function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}');await click(r.x,r.y);}
 async function stroke(x,y,xx,yy){await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});for(let i=1;i<=10;i++)await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+(xx-x)*i/10,y:y+(yy-y)*i/10,button:'left',buttons:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:xx,y:yy,button:'left',clickCount:1});}
 async function drawFourMarks(){
   for(const [tool,coords] of [['pen',[65,205,330,455]],['arrow',[420,245,280,125]],['rectangle',[60,195,350,432]],['ellipse',[374,200,666,432]]]){
     await clickEl(`button[aria-label="${tool}"]`);await stroke(...coords);
   }
 }
 drawing=true;win.webContents.send('page:drawing-mode',true);
 await until(()=>node('.draw-stage'),'drawing opened');

 const count=()=>call('.draw-ink','function(){return this.querySelector("g").childElementCount}');
 const key=async(key,code,modifiers=0)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers,windowsVirtualKeyCode:key==='Escape'?27:key==='Backspace'?8:key.toUpperCase().charCodeAt(0)});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers,windowsVirtualKeyCode:key==='Escape'?27:key==='Backspace'?8:key.toUpperCase().charCodeAt(0)});};
 await drawFourMarks();
 assert.equal(await count(),4,'four tools create four marks');
 await key('z','KeyZ',4); assert.equal(await count(),3,'Cmd+Z undoes drawing');
 await key('Z','KeyZ',12); assert.equal(await count(),4,'Cmd+Shift+Z redoes drawing');
 await key('Backspace','Backspace'); assert.equal(await count(),3,'Delete removes last mark');
 await key('z','KeyZ',4); assert.equal(await count(),4,'undo restores deleted mark');
 await clickEl('button[aria-label="clear"]'); assert.equal(await count(),0);
 await key('z','KeyZ',4); assert.equal(await count(),4,'undo restores cleared drawing');
 await clickEl('textarea');
 await cdp('Input.insertText',{text:'Move these cards beside the title'});
 assert.equal(await call('textarea','function(){return this.value}'),'Move these cards beside the title','native typing works');
 await key('Escape','Escape'); await until(()=>!drawing,'Escape exits drawing');
 drawing=true;win.webContents.send('page:drawing-mode',true);await until(()=>node('.draw-stage'),'fresh drawing opened');
 assert.equal(await count(),0,'new drawing starts without previous marks');
 assert.equal(await call('textarea','function(){return this.value}'),'','new drawing starts without previous text');
 await drawFourMarks();
 await clickEl('textarea');await cdp('Input.insertText',{text:'Move these cards beside the title'});
 await clickEl('button[aria-label="pen"]');
 await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Control',code:'ControlLeft',modifiers:2});
 await new Promise(r=>setTimeout(r,450)); // a modifier talks once it's held a moment
 await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Control',code:'ControlLeft'});
 await until(()=>ptt.length>=2,'Control reaches dictation'); assert.deepEqual(ptt.slice(-2),[true,false]);
 win.webContents.send('page:cmd',{type:'comment.state',state:{instant:true,recording:false,transcribing:true,partial:''}});
 await pause(50);await clickEl('button[aria-label="Send"]');await pause(50);
 assert.equal(submitted,null,'cannot send while transcription is pending');
 win.webContents.send('page:cmd',{type:'comment.state',state:{instant:true,recording:false,transcribing:false,partial:''}});
 win.webContents.send('page:cmd',{type:'comment.insert',text:'please'});await pause(50);
 assert.equal(await call('textarea','function(){return this.value}'),'Move these cards beside the title please','dictated words insert');
 win.setSize(900,680);await pause(100);
 assert.equal(await count(),4,'resize retains captured marks');

 await pause(100);
 fs.writeFileSync(path.join(artifacts,'drawing.png'),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG());
 assert.equal(await win.webContents.executeJavaScript('window.pageClicks'),0,'page clicks blocked: '+await win.webContents.executeJavaScript('JSON.stringify(window.leaks)'));assert.equal(await win.webContents.executeJavaScript('window.pageKeys'),0,'page keyboard shortcuts blocked');
 await clickEl('button[aria-label="Send"]');
 await until(()=>submitted,'annotation submitted');
 assert.equal(submitted.annotation.strokes.length,4);
 assert.equal(submitted.text,'Move these cards beside the title please');
 assert.ok(submitted.annotation.image.dataUrl.startsWith('data:image/jpeg;base64,'));
 fs.writeFileSync(path.join(artifacts,'export.jpg'),Buffer.from(submitted.annotation.image.dataUrl.split(',')[1],'base64'));
 fs.writeFileSync(path.join(artifacts,'annotation.json'),JSON.stringify(submitted.annotation));

 const target=submitted.annotation.targetSamples[0];
 const thread={threadId:'drawing-smoke',pageUrl:submitted.annotation.pageUrl,anchor:{pageUrl:submitted.annotation.pageUrl,selector:target.details.selector,domPath:target.elementPath,dataSource:target.dataSource,label:target.label,text:target.details.text,role:null,tag:target.details.tag,bounds:target.details.bounds},title:'Drawing smoke',state:'idle',intent:'task',summary:'',unread:false,awaitingReply:false,createdAt:1,lastInteractionAt:1,messages:[{id:'request',turnId:'drawing-smoke',at:1,role:'user',kind:'request',text:submitted.text,annotation:submitted.annotation}]};
 win.webContents.send('page:cmd',{type:'threads',threads:[thread]});
 win.webContents.send('page:open-thread','drawing-smoke');
 await until(()=>node('.drawing-preview'),'thread preview');
 await clickEl('.drawing-preview');await until(()=>previewOpen,'preview IPC opened');
 assert.equal(await call('.drawing-lightbox','function(){return this.open}'),true);
 win.webContents.send('page:cmd',{type:'threads',threads:[{...thread,summary:'Updated while preview open'}]});await pause(80);
 assert.equal(await call('.drawing-lightbox','function(){return this.open}'),true,'thread rerender retains modal');
 await key('Escape','Escape');await until(()=>!previewOpen,'preview Escape cleanup');
 assert.ok(await node('.th-panel'),'closing preview leaves thread panel open');
 await clickEl('.drawing-preview');await until(()=>previewOpen,'preview reopens');
 await call('.drawing-lightbox','function(){this.remove()}');await until(()=>!previewOpen,'external removal cleanup');
 console.log(JSON.stringify({passed:true,tools:submitted.annotation.strokes.map(s=>s.tool),targets:submitted.annotation.targetSamples.map(s=>s.label),image:submitted.annotation.image.width+'x'+submitted.annotation.image.height,pageClicks:0}));
}
main().then(()=>app.quit()).catch(e=>{console.error(e);app.exit(1);});
