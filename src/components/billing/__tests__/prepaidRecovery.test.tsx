// @vitest-environment jsdom
import React from 'react';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import PaymentHistory from '../PaymentHistory';
import Notice from '../PaymentProcessingNotice';
import {openRazorpayCheckout} from '@/lib/billing/razorpay';
const mocks=vi.hoisted(()=>({from:vi.fn(),session:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({from:mocks.from,auth:{getSession:mocks.session}})}));
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();delete (window as any).Razorpay});
function history(result:any){vi.stubEnv('NEXT_PUBLIC_RAZORPAY_KEY_ID','rzp_live_fixture');const query:any={select:vi.fn(()=>query),eq:vi.fn(()=>query),order:vi.fn(()=>query),limit:vi.fn(async()=>result)};mocks.from.mockReturnValue(query);render(<PaymentHistory userId="fixture-user"/>);return query;}
describe('prepaid payment recovery and own-order history',()=>{
 it('renders actual paid and incomplete orders, distinguishes orders from receipts, scopes account and mode',async()=>{const q=history({data:[{id:'fixture-order',provider_order_id:'order_fixture',amount_paise:49900,currency:'INR',status:'paid',plan_code:'monthly',created_at:'2026-11-27T05:00:00Z',paid_at:'2026-11-27T05:01:00Z',mode:'live'},{id:'pending-order',amount_paise:14900,currency:'INR',status:'created',addon_code:'addon_10',created_at:'2026-11-27T05:00:00Z',mode:'live'}]});await screen.findByText('Paid');expect(q.eq).toHaveBeenCalledWith('user_id','fixture-user');expect(q.eq).toHaveBeenCalledWith('mode','live');expect(q.limit).toHaveBeenCalledWith(50);expect(screen.getByText('Not confirmed')).toBeTruthy();expect(screen.getByText(/Receipt downloads are not available/)).toBeTruthy();expect(screen.queryByRole('link',{name:/download/i})).toBeNull();});
 it('shows empty, not failed, history only after successful empty read',async()=>{history({data:[]});await screen.findByText('No payment orders found for this account.');});
 it('read failures show retry, never fake empty history',async()=>{const q=history({error:{message:'fixture failure'}});await screen.findByRole('alert');expect(screen.queryByText('No payment orders found for this account.')).toBeNull();q.limit.mockResolvedValue({data:[]});fireEvent.click(screen.getByText('Refresh history'));await screen.findByText('No payment orders found for this account.');});
 it('notice retries verification only and guards double clicks',async()=>{let done!:()=>void;const retry=vi.fn(()=>new Promise<void>(r=>{done=r}));render(<Notice payment={{orderId:'order_fixture',paymentId:'pay_fixture',retry}}/>);const b=screen.getByRole('button',{name:'Check payment status'});fireEvent.click(b);fireEvent.click(b);expect(retry).toHaveBeenCalledTimes(1);expect(screen.getByText(/Do not pay again/)).toBeTruthy();done();await waitFor(()=>expect((b as HTMLButtonElement).disabled).toBe(false));});
 it('publishes recovery before first verify resolves and refuses another account on retry',async()=>{
   vi.stubEnv('NEXT_PUBLIC_BILLING_ENABLED','true');vi.stubEnv('NEXT_PUBLIC_RAZORPAY_KEY_ID','rzp_live_fixture');
   mocks.session.mockResolvedValue({data:{session:{user:{id:'account-a'},access_token:'token-a'}}});
   let opts:any, finish!: (value:any)=>void;
   (window as any).Razorpay=class{constructor(o:any){opts=o}open(){}on(){}};
   const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({orderId:'order_a',amount:49900,currency:'INR'}),{status:200})).mockImplementationOnce(()=>new Promise(r=>{finish=r}));
   vi.stubGlobal('fetch',fetcher);const onPending=vi.fn(),onSuccess=vi.fn();
   await openRazorpayCheckout({userId:'account-a',authToken:'token-a',onPending,onSuccess});
   const running=opts.handler({razorpay_order_id:'order_a',razorpay_payment_id:'pay_a',razorpay_signature:'memory-only'});
   expect(onPending).toHaveBeenCalledTimes(1);
   await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
   mocks.session.mockResolvedValue({data:{session:{user:{id:'account-b'},access_token:'token-b'}}});
   finish(new Response(JSON.stringify({success:true}),{status:200}));await running;
   expect(onSuccess).not.toHaveBeenCalled();
   await onPending.mock.calls.at(-1)![0].retry();expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it.each(['pending','network','malformed','string','object','false'])('keeps %s verification unresolved and retries same order without charge or premature success',async(kind)=>{vi.stubEnv('NEXT_PUBLIC_BILLING_ENABLED','true');vi.stubEnv('NEXT_PUBLIC_RAZORPAY_KEY_ID','rzp_live_fixture');mocks.session.mockResolvedValue({data:{session:{access_token:'fresh-fixture-token'}}});let opts:any;const modal:any={open:vi.fn(),on:vi.fn()};(window as any).Razorpay=class{constructor(o:any){opts=o;return modal}};const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({orderId:'order_fixture',amount:49900,currency:'INR'}),{status:200}));if(kind==='network')fetcher.mockRejectedValueOnce(new Error('fixture timeout'));else fetcher.mockResolvedValueOnce(new Response(JSON.stringify(kind==='pending'?{code:'PAYMENT_NOT_CAPTURED'}:kind==='string'?{success:'true'}:kind==='object'?{verified:{}}:kind==='false'?{success:false}:{}),{status:kind==='pending'?400:200}));fetcher.mockResolvedValueOnce(new Response(JSON.stringify({success:true}),{status:200}));vi.stubGlobal('fetch',fetcher);const onPending=vi.fn(),onSuccess=vi.fn(),onDismiss=vi.fn(),onError=vi.fn();await openRazorpayCheckout({planCode:'monthly',authToken:'fixture-token',onPending,onSuccess,onDismiss,onError});await opts.handler({razorpay_order_id:'order_fixture',razorpay_payment_id:'pay_fixture',razorpay_signature:'fixture-signature'});expect(onPending).toHaveBeenCalledTimes(2);expect(onSuccess).not.toHaveBeenCalled();opts.modal.ondismiss();expect(onDismiss).not.toHaveBeenCalled();await onPending.mock.calls[0][0].retry();expect(onSuccess).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['/api/billing/razorpay/order','/api/billing/razorpay/verify','/api/billing/razorpay/verify']);expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[1][1].body);expect(onError).not.toHaveBeenCalled();});
});
