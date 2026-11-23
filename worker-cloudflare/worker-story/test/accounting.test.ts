import { it, expect } from 'vitest';
import { costEstimate, parseUsage } from '../src/accounting';
import { bindingFailure, classifiedFailure, responseFailure } from '../src/provider-errors';
const QWEN='@cf/qwen/qwen3.8-27b', GEMMA='@cf/google/gemma-4-26b-a4b-it';
it('公开价按输入/输出计费，total与reasoning不重复计算',()=>{
  const usage=parseUsage({prompt_tokens:1000,completion_tokens:500,total_tokens:1500,completion_tokens_details:{reasoning_tokens:300}});
  expect(costEstimate(QWEN,usage)).toMatchObject({estimated_usd:0.00205,input_usd:0.00045,output_usd:0.0016,is_estimate:true,actual_billed_usd:null,basis:'all_input_at_standard_rate'});
  expect(costEstimate(GEMMA,usage)).toMatchObject({estimated_usd:0.00025,pricing:{input:0.1,output:0.3,cached_input:null}});
});
it('只有明确缓存用量和单价时才应用折扣',()=>{
  const usage=parseUsage({prompt_tokens:1000,completion_tokens:500,prompt_tokens_details:{cached_tokens:800}});
  expect(costEstimate(QWEN,usage)).toMatchObject({estimated_usd:0.00173,cache_discount_applied:true,basis:'reported_cache_usage'});
  expect(costEstimate(GEMMA,usage)).toMatchObject({estimated_usd:0.00025,cache_discount_applied:false,basis:'all_input_at_standard_rate'});
});
it('缺失/异常用量不伪造零费用；真正零token可为零估算',()=>{
  for(const u of [{},{total_tokens:9},{prompt_tokens:2}])expect(costEstimate(QWEN,u)).toMatchObject({status:'unavailable',estimated_usd:null,reason:'missing_usage'});
  expect(costEstimate(QWEN,{prompt_tokens:0,completion_tokens:0})).toMatchObject({status:'estimated',estimated_usd:0});
  expect(costEstimate('unknown',{prompt_tokens:1,completion_tokens:1})).toMatchObject({reason:'unknown_model_price',estimated_usd:null});
  expect(costEstimate(QWEN,{prompt_tokens:1,completion_tokens:1,cached_input_tokens:2})).toMatchObject({reason:'inconsistent_usage',estimated_usd:null});
  expect(costEstimate(QWEN,{prompt_tokens:1,completion_tokens:1,total_tokens:9})).toMatchObject({reason:'inconsistent_usage',estimated_usd:null});
  expect(parseUsage({prompt_tokens:-1,completion_tokens:'100',total_tokens:Infinity})).toEqual({});
});
it.each([
 [402,undefined,402,'model_payment_required'],[429,3036,429,'model_quota_exceeded'],[403,5035,402,'model_paid_plan_required'],
 [429,3040,503,'model_capacity_exceeded'],[429,undefined,429,'model_rate_limited'],[403,undefined,502,'model_response_error'],[503,undefined,502,'model_response_error'],
])('计费、免费额度、限流与普通故障区分：%s/%s', (upstream,code,status,error)=>{
  expect(classifiedFailure(upstream as number,code as number|undefined)).toMatchObject({status,code:error});
});
it.each(['errors','error','top'])('安全解析错误包裹：%s',async shape=>{
 const info={code:3036,message:'包含私密凭据lm_以及原始正文'};
 const body=shape==='errors'?{errors:[info]}:shape==='error'?{error:info}:info;
 const failure=await responseFailure(Response.json(body,{status:429}),new AbortController().signal);
 expect(failure.code).toBe('model_quota_exceeded');expect(JSON.stringify(failure)).not.toContain('包含私密凭据');
});
it('超大、非JSON错误不泄漏正文，也不阻止按HTTP402显示提示',async()=>{
 for(const body of ['invalid secret','x'.repeat(16385)]){
  const error=await responseFailure(new Response(body,{status:402}),new AbortController().signal);
  expect(error.code).toBe('model_payment_required');expect(JSON.stringify(error)).not.toContain('secret');
 }
});
it('不从任意message、成功正文或未知异常文本猜测欠费',async()=>{
 const error=await responseFailure(Response.json({error:{message:'quota exceeded billing payment 3036'}},{status:500}),new AbortController().signal);
 expect(error.code).toBe('model_response_error');
 expect(bindingFailure(new Error('3036 secret quota exceeded'))).toBeNull();
 expect(bindingFailure(Object.assign(new Error('secret'),{code:3036}))).toMatchObject({code:'model_quota_exceeded'});
 expect(bindingFailure({code:'5035',message:'secret'})).toMatchObject({code:'model_paid_plan_required'});
});

it('错误响应若提供有效usage，保留而不暴露原始正文',async()=>{
 const failure=await responseFailure(Response.json({errors:[{code:3036,message:'secret'}],usage:{prompt_tokens:5,completion_tokens:2}},{status:429}),new AbortController().signal);
 expect(failure.details.usage).toEqual({prompt_tokens:5,completion_tokens:2});expect(JSON.stringify(failure)).not.toContain('secret');
});
