const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'../public/staff-ui.js'),'utf8');
const elements=new Map(),listeners=new Map();
const $=key=>{if(!elements.has(key))elements.set(key,{open:false,value:'',textContent:'',focus(){},reset(){},showModal(){this.open=true;},close(){this.open=false;const fn=listeners.get('close');listeners.delete('close');fn?.();},addEventListener(type,fn){listeners.set(type,fn);}});return elements.get(key);};
const context=vm.createContext({$,Promise,cancellationReason:''});
vm.runInContext(ui.slice(ui.indexOf('function operationReason('),ui.indexOf('function applyStaffUI(')),context);
vm.runInContext(app.slice(app.indexOf('async function confirmBookingCancellation('),app.indexOf('// ---------- api / ui helpers')),context);
(async()=>{
 let pending=context.confirmBookingCancellation('Hủy booking này?');
 assert.equal($('#operationReasonDlg').open,true);
 assert.equal(await context.confirmBookingCancellation('duplicate'),false);
 $('#operationReasonBack').onclick();assert.equal(await pending,false);
 pending=context.confirmBookingCancellation('Hủy booking này?');
 $('#operationReasonText').value='  Khách đổi kế hoạch  ';
 $('#operationReasonForm').onsubmit({preventDefault(){}});
 assert.equal(await pending,true);assert.equal(context.cancellationReason,'Khách đổi kế hoạch');
 console.log('Cancellation: reason required, trimmed, explicit confirmation, dismiss and duplicate guard OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
