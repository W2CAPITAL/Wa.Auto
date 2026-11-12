// Authenticate ProjectW1SC operators against THEIR Supabase Auth + office access RPC.
// Browser-supplied publishable key is intentionally public; a valid user access token
// and RLS-enforced office_has_access() are both required. No service_role secret.
const URL='https://ulkuhiibeoibbzhqrfya.supabase.co';
const uuid=x=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x||''));
export async function authorizeProjectW1SC(req,{requestFetch=fetch}={}){
 const jwt=String(req?.headers?.authorization||'').replace(/^Bearer\s+/i,'').trim();
 const key=String(req?.headers?.['x-wa-crm-publishable-key']||'').trim();
 if(!jwt||jwt.length>6000||!key||key.length>1400||/\s/.test(key))return null;
 const headers={apikey:key,Authorization:'Bearer '+jwt,Accept:'application/json'};
 const getUser=await requestFetch(URL+'/auth/v1/user',{method:'GET',headers,signal:AbortSignal.timeout(6500),redirect:'error'});
 if(!getUser.ok)return null;
 const user=await getUser.json().catch(()=>null);
 if(!uuid(user?.id))return null;
 const permission=await requestFetch(URL+'/rest/v1/rpc/office_has_access',{
  method:'POST',headers:{...headers,'Content-Type':'application/json'},
  body:'{}',signal:AbortSignal.timeout(6500),redirect:'error'
 });
 if(!permission.ok)return null;
 const allowed=await permission.json().catch(()=>false);
 if(allowed!==true)return null;
 return {ok:true,userId:user.id,empresaId:null,role:'ProjectW1SC',canManage:false};
}
