const {imageSources,unwrap,DEFAULT_CONNECTION}=require('./api');
const POLL_INTERVAL_MS=4000;
class TaskQueue{
 constructor({jobs=[],persist,client,onChange}){
  this.jobs=jobs;this.persist=persist;this.client=client;this.onChange=onChange;
  this.querying=new Map();this.lastTimerTickAt=Date.now();
  jobs.forEach(job=>{
   if(job.connection?.protocol==='openai' && job.state==='submitting'){job.state='uncertain';job.error='上次同步请求已中断，请先到 API 平台核对记录，勿重复生成。';}
   for(const entry of [...(job.timing?.submits||[]),...(job.timing?.queries||[])]){
    if(!entry.endedAt && !entry.interruptedAt){entry.interruptedAt=Date.now();entry.outcome='interrupted';}
   }
  });
 }
 save(){this.persist(this.jobs);this.onChange();}
 timing(job){return job.timing ||= {version:1,submits:[],queries:[],queryCount:0,maxTimerGapMs:0};}
 persistTiming(){try{this.persist(this.jobs);}catch(_){/* Timing storage must not interrupt generation or polling. */}}
 trace(entry,event){
  if(event.phase==='request-start'){entry.requestAt=event.at;entry.timeoutMs=event.timeoutMs;}
  if(event.phase==='headers'){entry.headersAt=event.at;entry.httpStatus=event.httpStatus;entry.cache=event.cache;}
  if(event.phase==='body'){entry.bodyAt=event.at;entry.serverState=event.serverState;entry.serverFinal=event.serverFinal;}
  if(event.phase==='timeout'){entry.timeoutFiredAt=event.at;entry.timeoutElapsedMs=event.elapsedMs;}
  if(event.phase==='error'){entry.errorAt=event.at;entry.errorStage=event.stage;entry.errorType=event.errorType;}
  this.persistTiming();
 }
 exportTimings(){
  return {formatVersion:1,exportedAt:Date.now(),pollIntervalMs:POLL_INTERVAL_MS,jobs:this.jobs.map(job=>({
   id:job.id,createdAt:job.createdAt,model:job.model,count:job.count,quality:job.quality,
   inputWidth:job.captureWidth,inputHeight:job.captureHeight,protocol:job.connection?.protocol||'lk888',
   timing:job.timing||null
  }))};
 }
 async submit(record,images,params){
  const startedAt=Date.now(),api=await this.client(record.connection),clientReadyAt=Date.now();
  const index=this.jobs.findIndex(j=>j.id===record.id);if(index>=0)this.jobs[index]=record;else this.jobs.unshift(record);
  const timing=this.timing(record);timing.startedAt=startedAt;timing.clientReadyAt=clientReadyAt;
  this.save();
  if(record.connection?.protocol==='openai'){void this.submitTasks(record,images,params,api);return;}
  await this.submitTasks(record,images,params,api);
 }
 // Synchronous image editing may take minutes; keep the editor available while it runs.
 async submitTasks(record,images,params,api){
  for(let i=0;i<record.count;i++){
   const timing=this.timing(record),entry={index:i,startedAt:Date.now()};
   timing.submits.push(entry);record.state='submitting';this.save();
   try{
    const result=await api.submit(record.model,record.instruction,images,params,event=>this.trace(entry,event));
    entry.endedAt=Date.now();entry.outcome='success';
    const task=typeof result==='string'?{id:result,state:'running',results:[]}:{id:record.id+'-'+i,state:'ready',results:result.results.map(source=>({source,imported:false}))};
    entry.taskId=task.id;record.tasks.push(task);this.save();
   }catch(e){entry.endedAt=Date.now();entry.outcome='error';record.state='uncertain';record.error=e.message;this.save();return;}
  }
  record.state=record.tasks.every(task=>task.state==='ready')?'ready':'running';this.save();
 }
 async tick(trigger='timer'){
  let timerGapMs;
  if(trigger==='timer'){const now=Date.now();timerGapMs=now-this.lastTimerTickAt;this.lastTimerTickAt=now;}
  await Promise.all(this.jobs.flatMap(job=>job.tasks.filter(task=>task.state==='running').map(task=>this.query(job,task,trigger,timerGapMs))));
 }
 async query(job,task,trigger='manual',timerGapMs){
  const timing=this.timing(job);
  if(timerGapMs!==undefined)timing.maxTimerGapMs=Math.max(timing.maxTimerGapMs,timerGapMs);
  const pending=this.querying.get(task.id);
  if(pending){pending.skippedPolls=(pending.skippedPolls||0)+1;pending.lastSkippedAt=Date.now();return;}
  const previous=timing.queries[timing.queries.length-1];
  const entry={taskId:task.id,trigger,startedAt:Date.now(),timerGapMs};
  if(previous)entry.sincePreviousQueryMs=entry.startedAt-previous.startedAt;
  // Bound local diagnostics while retaining submission times and aggregate counts.
  timing.queries.push(entry);if(timing.queries.length>200)timing.queries.shift();timing.queryCount++;
  this.querying.set(task.id,entry);this.persistTiming();
  try{
   const api=await this.client(job.connection||DEFAULT_CONNECTION);entry.clientReadyAt=Date.now();
   const response=await api.status(task.id,event=>this.trace(entry,event)),data=unwrap(response),state=data.state||response.state;
   if(trigger==='diagnostic'){entry.outcome='diagnostic-response';return;}
   task.progress=data.progress??response.progress;task.updatedAt=Date.now();task.error=null;
   entry.outcome='response';entry.observedAt=task.updatedAt;
   if(data.is_final||response.is_final||['success','failed','error'].includes(state)){
    task.state=state==='success'?'ready':'failed';task.error=state==='success'?null:String(data.error||response.error||'平台任务失败');
    task.results=imageSources(response).map(source=>({source,imported:false}));
    if(task.state==='ready'&&!task.results.length){task.state='failed';task.error='平台完成但没有返回可识别图片。';}
    entry.outcome=task.state;entry.completedObservedAt=Date.now();
   }else task.platformState=state||'running';
   if(job.state!=='uncertain')job.state=job.tasks.every(t=>t.state==='ready')?'ready':job.tasks.some(t=>t.state==='running')?'running':'failed';
  }catch(e){entry.outcome='error';if(trigger!=='diagnostic')task.error=e.message;}
  finally{entry.endedAt=Date.now();this.querying.delete(task.id);this.save();}
 }
}
module.exports={TaskQueue,POLL_INTERVAL_MS};
