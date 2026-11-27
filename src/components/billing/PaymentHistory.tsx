'use client';
import React, {useEffect,useState} from 'react';
import {createClient} from '@/lib/supabase/client';
import {getRazorpayKeyMode} from '@/lib/billing/mode';
interface Order { id:string;provider_order_id:string|null;plan_code:string|null;addon_code:string|null;amount_paise:number;currency:string;status:string;created_at:string;paid_at:string|null;mode:string }
export default function PaymentHistory({userId}:{userId:string}) {
  const [orders,setOrders]=useState<Order[]>([]), [loading,setLoading]=useState(true),[error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  useEffect(()=>{let active=true;setLoading(true);setError('');setOrders([]);
    (async()=>{try{
      const mode=getRazorpayKeyMode(process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID);
      if(mode==='unknown')throw new Error('Payment history is unavailable right now.');
      const {data,error}=await createClient().from('payment_orders').select('id,provider_order_id,plan_code,addon_code,amount_paise,currency,status,created_at,paid_at,mode').eq('user_id',userId).eq('mode',mode).order('created_at',{ascending:false}).limit(50);
      if(error)throw error;
      if(active)setOrders(data||[]);
    }catch{if(active)setError('Could not load payment history. Try again or contact support.');}finally{if(active)setLoading(false)}})();return()=>{active=false};
  },[userId,revision]);
  return <section aria-label="Payment history" className="space-y-3 border-t border-slate-200 pt-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold text-sm text-slate-900">Payment history</h3><button type="button" disabled={loading} onClick={()=>setRevision(x=>x+1)} className="text-blue-700 text-xs font-semibold min-h-[44px] disabled:opacity-50">{loading?'Loading...':'Refresh history'}</button></div>
    <p className="text-xs text-slate-500">Latest 50 orders, including incomplete checkouts. An order is not proof of a charge or a tax invoice.</p>
    {loading?<p role="status" className="text-sm text-slate-500">Loading payment history...</p>:error?<p role="alert" className="text-sm text-red-700">{error}</p>:orders.length===0?<p className="text-sm text-slate-500">No payment orders found for this account.</p>:<ul className="space-y-3">{orders.map(order=><li key={order.id} className="rounded-xl border border-slate-200 p-4 text-sm space-y-2 break-words">
      <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{order.plan_code?`${order.plan_code} plan`:order.addon_code?`${order.addon_code} add-on`:'Payment order'}</span><span>{new Intl.NumberFormat('en-IN',{style:'currency',currency:order.currency}).format(order.amount_paise/100)}</span></div>
      <p className="font-medium">{order.mode==='test'?'Test order · ':''}{({created:'Not confirmed',paid:'Paid',failed:'Failed order',expired:'Expired order'} as Record<string,string>)[order.status]||'Status unavailable'}</p>
      <p className="text-xs text-slate-500">Created: {new Date(order.created_at).toLocaleString()}{order.paid_at&&<> · Paid: {new Date(order.paid_at).toLocaleString()}</>}</p>
      <p className="text-xs break-all">Order reference: {order.provider_order_id||order.id}</p>
      {order.status==='created'&&<p className="text-xs text-slate-600">This order has no confirmed payment recorded. If debited, do not pay again. Refresh later or contact support with the reference.</p>}
      {order.mode==='test'&&<p className="text-xs text-slate-600">Test payments do not grant paid access.</p>}
    </li>)}</ul>}
    <p className="text-xs text-slate-500">Receipt downloads are not available here. For payment confirmation or receipt help, contact <a href="mailto:support@careermonke.com" className="underline text-blue-700">support@careermonke.com</a> with your order reference. Refund and dispute details are not shown in this list.</p>
  </section>;
}
