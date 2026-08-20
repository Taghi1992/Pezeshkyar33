const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const archiver = require("archiver");
const XLSX = require("xlsx");

require("dotenv").config?.();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false });

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./storage/uploads");
const backupDir = path.resolve(process.env.BACKUP_DIR || "./storage/backups");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use(session({
  store: new pgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "CHANGE_ME",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, "..", "public")));

async function q(text, params = []) { return pool.query(text, params); }
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await q(schema);
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const exists = await q("SELECT id FROM users WHERE email=$1", [process.env.ADMIN_EMAIL]);
    if (!exists.rowCount) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await q("INSERT INTO users(email,password_hash,role,full_name) VALUES($1,$2,'admin',$3)", [process.env.ADMIN_EMAIL, hash, "مدیر سامانه"]);
    }
  }
}
function auth(req,res,next){ if(!req.session.user) return res.status(401).json({error:"نیاز به ورود"}); next(); }
function role(...roles){ return (req,res,next)=> roles.includes(req.session.user?.role) ? next() : res.status(403).json({error:"دسترسی مجاز نیست"}); }
function encryptSecret(value){
  if(!value)return null;
  const key=crypto.createHash("sha256").update(process.env.SESSION_SECRET||"CHANGE_ME").digest();
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv("aes-256-gcm",key,iv);
  const e=Buffer.concat([c.update(value,"utf8"),c.final()]);
  return iv.toString("hex")+":"+c.getAuthTag().toString("hex")+":"+e.toString("hex");
}
function makeRecordNo(){ return `PR-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`; }

app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"..","public","index.html")));
app.get("/admin-login",(req,res)=>res.sendFile(path.join(__dirname,"..","public","index.html")));

app.post("/api/auth/login", async (req,res)=>{
  try{
    const {email,password} = req.body;
    const r=await q("SELECT id,email,password_hash,role,full_name,active FROM users WHERE email=$1",[email]);
    if(!r.rowCount || !r.rows[0].active || !(await bcrypt.compare(password,r.rows[0].password_hash))) return res.status(401).json({error:"ایمیل یا رمز عبور نادرست است"});
    const u=r.rows[0]; req.session.user={id:u.id,email:u.email,role:u.role,full_name:u.full_name};
    res.json({user:req.session.user});
  }catch(e){res.status(500).json({error:"خطای ورود"});}
});
app.post("/api/auth/logout", (req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/auth/me",(req,res)=>res.json({user:req.session.user||null}));


app.get("/api/doctors",async(req,res)=>{
  const r=await q(`SELECT id,full_name,email,specialty,address,insurance_type
    FROM users WHERE role='doctor' AND active=true ORDER BY full_name`);
  res.json(r.rows);
});
app.post("/api/admin/doctors",auth,role("admin"),async(req,res)=>{
  try{
    const {email,password,full_name,specialty,address,insurance_type}=req.body;
    const hash=await bcrypt.hash(password,12);
    const r=await q(`INSERT INTO users(email,password_hash,role,full_name,specialty,address,insurance_type)
      VALUES($1,$2,'doctor',$3,$4,$5,$6) RETURNING id,email,full_name,specialty,address,insurance_type`,
      [email,hash,full_name,specialty||null,address||null,insurance_type||null]);
    res.status(201).json(r.rows[0]);
  }catch(e){res.status(400).json({error:"پزشک ایجاد نشد؛ ایمیل ممکن است تکراری باشد"});}
});
app.get("/api/admin/subscriptions",auth,role("admin"),async(req,res)=>{
  const r=await q(`SELECT s.*,u.full_name AS doctor_name,u.specialty,u.address,u.insurance_type
    FROM subscriptions s JOIN users u ON u.id=s.doctor_id ORDER BY s.created_at DESC`);
  res.json(r.rows);
});
app.post("/api/admin/subscriptions",auth,role("admin"),async(req,res)=>{
  try{
    const {doctor_id,plan_name,price,start_date,end_date,payment_method="manual",payment_status="paid",transaction_id}=req.body;
    const r=await q(`INSERT INTO subscriptions(doctor_id,plan_name,price,start_date,end_date,payment_method,payment_status,transaction_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [doctor_id,plan_name,Number(price||0),start_date,end_date,payment_method,payment_status,transaction_id||null,req.session.user.id]);
    res.status(201).json(r.rows[0]);
  }catch(e){res.status(400).json({error:"اشتراک ثبت نشد"});}
});

function xmlEscape(v){
  return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}
function xmlValue(xml,tag){
  const m=xml.match(new RegExp("<(?:\\w+:)?"+tag+"[^>]*>([\\s\\S]*?)</(?:\\w+:)?"+tag+">","i"));
  return m?m[1].replace(/<!\\[CDATA\\[|\\]\\]>/g,"").trim():null;
}
function soapPost(url,action,body){
  return new Promise((resolve,reject)=>{
    const u=new URL(url), data=Buffer.from(body);
    const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:"POST",
      headers:{"Content-Type":"text/xml; charset=utf-8","SOAPAction":`"${action}"`,"Content-Length":data.length},
      timeout:20000},r=>{
        let x="";r.setEncoding("utf8");r.on("data",c=>x+=c);r.on("end",()=>resolve(x));
      });
    req.on("error",reject);req.on("timeout",()=>req.destroy(new Error("درگاه پارسیان timeout")));req.write(data);req.end();
  });
}
function parsianUrls(){
  return {
    sale:"https://pec.shaparak.ir/NewIPGServices/Sale/SaleService.asmx?WSDL",
    verify:"https://pec.shaparak.ir/NewIPGServices/Verify/VerifyService.asmx?WSDL",
    confirm:"https://pec.shaparak.ir/NewIPGServices/Confirm/ConfirmService.asmx?WSDL",
    reverse:"https://pec.shaparak.ir/NewIPGServices/Reverse/ReversalService.asmx?WSDL"
  };
}
function parsianSaleXml(pin,orderId,amount,callback){
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><SalePaymentRequest xmlns="http://tempuri.org/"><requestData><LoginAccount>${xmlEscape(pin)}</LoginAccount><Amount>${amount}</Amount><OrderId>${orderId}</OrderId><CallBackUrl>${xmlEscape(callback)}</CallBackUrl><AdditionalData></AdditionalData><Originator></Originator></requestData></SalePaymentRequest></soap:Body></soap:Envelope>`;
}
function parsianVerifyXml(pin,token){
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><VerifyPayment xmlns="http://tempuri.org/"><requestData><LoginAccount>${xmlEscape(pin)}</LoginAccount><Token>${xmlEscape(token)}</Token></requestData></VerifyPayment></soap:Body></soap:Envelope>`;
}
function parsianConfirmXml(pin,token){
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ConfirmPayment xmlns="http://tempuri.org/"><requestData><LoginAccount>${xmlEscape(pin)}</LoginAccount><Token>${xmlEscape(token)}</Token></requestData></ConfirmPayment></soap:Body></soap:Envelope>`;
}
async function getParsianConfig(ownerUserId,doctorId){
  const r=await q(`SELECT * FROM parsian_settings WHERE active=true AND (owner_user_id=$1 OR owner_user_id=$2 OR is_default=true)
    ORDER BY CASE WHEN owner_user_id=$1 THEN 0 WHEN owner_user_id=$2 THEN 1 ELSE 2 END,id DESC LIMIT 1`,
    [ownerUserId||0,doctorId||0]);
  if(!r.rowCount) throw new Error("پذیرندگی فعال پارسیان برای این پزشک/مدیر ثبت نشده است");
  const cfg=r.rows[0];
  if(!cfg.pin) throw new Error("کد پذیرنده (PIN) پارسیان ثبت نشده است");
  return cfg;
}
app.get("/api/admin/parsian-settings",auth,async(req,res)=>{
  const r=await q(`SELECT id,owner_user_id,merchant_id,terminal_id,username,callback_url,environment,active,is_default,updated_at
    FROM parsian_settings WHERE owner_user_id=$1 OR (owner_user_id IS NULL AND $2='admin')
    ORDER BY id DESC LIMIT 1`,[req.session.user.id,req.session.user.role]);
  res.json(r.rows[0]||null);
});
app.post("/api/admin/parsian-settings",auth,async(req,res)=>{
  try{
    const allowed=["admin","doctor"];
    if(!allowed.includes(req.session.user.role)) return res.status(403).json({error:"فقط مدیر یا پزشک مجاز است"});
    const {merchant_id,terminal_id,username,password,pin,callback_url,environment="production",active=true,is_default=false}=req.body;
    if(!pin && !merchant_id) return res.status(400).json({error:"PIN/شناسه پذیرنده پارسیان الزامی است"});
    const r=await q(`INSERT INTO parsian_settings(owner_user_id,merchant_id,terminal_id,username,password_encrypted,pin,callback_url,environment,active,is_default,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$1)
      RETURNING id,owner_user_id,merchant_id,terminal_id,username,callback_url,environment,active,is_default,updated_at`,
      [req.session.user.id,merchant_id||null,terminal_id||null,username||null,password?encryptSecret(password):null,pin||merchant_id,callback_url||null,environment,active,is_default]);
    res.status(201).json(r.rows[0]);
  }catch(e){res.status(400).json({error:"اطلاعات پذیرندگی ذخیره نشد"});}
});
app.post("/api/payments/parsian/start",auth,async(req,res)=>{
  try{
    const {amount,doctor_id,patient_id,appointment_id,subscription_id,description=""}=req.body;
    const n=Number(amount);
    if(!Number.isSafeInteger(n)||n<=0) return res.status(400).json({error:"مبلغ نامعتبر است"});
    const cfg=await getParsianConfig(req.session.user.id,doctor_id||req.session.user.id);
    const orderId=Number(String(Date.now()).slice(-12)+String(Math.floor(Math.random()*90)+10));
    const callback=cfg.callback_url || `${req.protocol}://${req.get("host")}/api/payments/parsian/callback`;
    const tx=await q(`INSERT INTO payment_transactions(user_id,doctor_id,patient_id,appointment_id,subscription_id,order_id,amount,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'created') RETURNING id`,
      [req.session.user.id,doctor_id||null,patient_id||null,appointment_id||null,subscription_id||null,orderId,n]);
    const xml=await soapPost(parsianUrls().sale,"SalePaymentRequest",parsianSaleXml(cfg.pin,orderId,n,callback));
    const status=xmlValue(xml,"Status"), token=xmlValue(xml,"Token");
    if(String(status)!=="0" || !token){
      await q("UPDATE payment_transactions SET status='failed',gateway_status=$1,raw_callback=$2 WHERE id=$3",[status||"NO_TOKEN",JSON.stringify({xml}),tx.rows[0].id]);
      return res.status(502).json({error:"دریافت توکن از پارسیان ناموفق بود",gateway_status:status});
    }
    await q("UPDATE payment_transactions SET token,status='redirected' WHERE id=$1",[tx.rows[0].id]);
    res.json({ok:true,payment_id:tx.rows[0].id,order_id:orderId,token,payment_url:`https://pec.shaparak.ir/NewIPG/?Token=${encodeURIComponent(token)}`});
  }catch(e){console.error(e);res.status(502).json({error:e.message||"خطا در ارتباط با پارسیان"});}
});
app.all("/api/payments/parsian/callback",async(req,res)=>{
  try{
    const body=Object.assign({},req.query,req.body), token=body.Token||body.token;
    const tx=await q("SELECT * FROM payment_transactions WHERE token=$1 ORDER BY id DESC LIMIT 1",[token]);
    if(!tx.rowCount) return res.status(404).send("تراکنش یافت نشد");
    const t=tx.rows[0];
    const cfg=await getParsianConfig(t.user_id,t.doctor_id);
    const gatewayStatus=body.status||body.Status||null;
    if(String(gatewayStatus)!=="0" && gatewayStatus!==null){
      await q("UPDATE payment_transactions SET status='failed',gateway_status=$1,raw_callback=$2 WHERE id=$3",[String(gatewayStatus),JSON.stringify(body),t.id]);
      return res.redirect("/?payment=failed&order="+t.order_id);
    }
    const verifyXml=await soapPost(parsianUrls().verify,"VerifyPayment",parsianVerifyXml(cfg.pin,t.token));
    const verifyStatus=xmlValue(verifyXml,"Status");
    if(String(verifyStatus)!=="0"){
      await q("UPDATE payment_transactions SET status='failed',gateway_status=$1,raw_callback=$2 WHERE id=$3",[verifyStatus||"VERIFY_FAILED",JSON.stringify(body),t.id]);
      return res.redirect("/?payment=failed&order="+t.order_id);
    }
    const confirmXml=await soapPost(parsianUrls().confirm,"ConfirmPayment",parsianConfirmXml(cfg.pin,t.token));
    const confirmStatus=xmlValue(confirmXml,"Status");
    const rrn=xmlValue(confirmXml,"RRN")||xmlValue(verifyXml,"RRN");
    if(String(confirmStatus)!=="0"){
      await q("UPDATE payment_transactions SET status='failed',gateway_status=$1,raw_callback=$2 WHERE id=$3",[confirmStatus||"CONFIRM_FAILED",JSON.stringify(body),t.id]);
      return res.redirect("/?payment=failed&order="+t.order_id);
    }
    await q("UPDATE payment_transactions SET status='confirmed',gateway_status='0',rrn=$1,raw_callback=$2,paid_at=NOW() WHERE id=$3",[rrn||null,JSON.stringify(body),t.id]);
    if(t.appointment_id) await q("UPDATE appointments SET payment_status='paid',payment_method='parsian',payment_transaction_id=$1 WHERE id=$2",[String(t.id),t.appointment_id]);
    if(t.subscription_id) await q("UPDATE subscriptions SET payment_status='paid',status='active',transaction_id=$1 WHERE id=$2",[String(t.id),t.subscription_id]);
    res.redirect("/?payment=success&order="+t.order_id);
  }catch(e){console.error(e);res.redirect("/?payment=error");}
});
app.get("/api/patients", auth, async(req,res)=>{
  const s=(req.query.search||"").trim();
  const r=await q(`SELECT p.*, mr.id AS record_id FROM patients p LEFT JOIN medical_records mr ON mr.patient_id=p.id
    WHERE $1='' OR p.full_name ILIKE '%'||$1||'%' OR p.national_id ILIKE '%'||$1||'%' OR p.mobile ILIKE '%'||$1||'%' OR p.medical_record_no ILIKE '%'||$1||'%'
    ORDER BY p.created_at DESC LIMIT 100`,[s]);
  res.json(r.rows);
});

app.post("/api/patients", auth, role("admin","doctor","secretary"), async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    const {full_name,national_id,mobile,birth_date,gender,blood_type}=req.body;
    if(!full_name) throw new Error("نام بیمار الزامی است");
    const p=await c.query(`INSERT INTO patients(medical_record_no,national_id,full_name,mobile,birth_date,gender,blood_type)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[makeRecordNo(),national_id||null,full_name,mobile||null,birth_date||null,gender||null,blood_type||null]);
    await c.query("INSERT INTO medical_records(patient_id) VALUES($1)",[p.rows[0].id]);
    await c.query("COMMIT");
    res.status(201).json(p.rows[0]);
  }catch(e){await c.query("ROLLBACK");res.status(400).json({error:e.message});}finally{c.release();}
});

app.get("/api/patients/:id", auth, async(req,res)=>{
  const p=await q("SELECT * FROM patients WHERE id=$1",[req.params.id]);
  if(!p.rowCount)return res.status(404).json({error:"بیمار یافت نشد"});
  const record=await q("SELECT * FROM medical_records WHERE patient_id=$1",[req.params.id]);
  const visits=await q(`SELECT v.*, u.full_name AS doctor_name, a.appointment_date, a.start_time
    FROM visits v JOIN users u ON u.id=v.doctor_id LEFT JOIN appointments a ON a.id=v.appointment_id
    WHERE v.patient_id=$1 ORDER BY v.visit_date DESC`,[req.params.id]);
  for(const v of visits.rows){ const meds=await q("SELECT medication,dosage,instructions FROM prescriptions WHERE visit_id=$1",[v.id]); v.prescriptions=meds.rows; }
  const files=await q("SELECT id,original_name,mime_type,size_bytes,created_at FROM attachments WHERE patient_id=$1 ORDER BY created_at DESC",[req.params.id]);
  res.json({patient:p.rows[0],record:record.rows[0],visits:visits.rows,attachments:files.rows});
});

app.post("/api/visits", auth, role("doctor","admin"), async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    const {patient_id,appointment_id,diagnosis,notes,vitals,lab_results,prescriptions=[]}=req.body;
    const doctorId=req.session.user.role==="doctor"?req.session.user.id:req.body.doctor_id;
    const v=await c.query(`INSERT INTO visits(patient_id,doctor_id,appointment_id,diagnosis,notes,vitals,lab_results)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[patient_id,doctorId,appointment_id||null,diagnosis||null,notes||null,vitals||{},lab_results||null]);
    for(const m of prescriptions) if(m.medication) await c.query("INSERT INTO prescriptions(visit_id,medication,dosage,instructions) VALUES($1,$2,$3,$4)",[v.rows[0].id,m.medication,m.dosage||null,m.instructions||null]);
    if(appointment_id) await c.query("UPDATE appointments SET status='completed' WHERE id=$1",[appointment_id]);
    await c.query("COMMIT"); res.status(201).json(v.rows[0]);
  }catch(e){await c.query("ROLLBACK");res.status(400).json({error:e.message});}finally{c.release();}
});

const maxMb=Number(process.env.MAX_UPLOAD_MB||15);
const storage=multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase())});
const uploader=multer({storage,limits:{fileSize:maxMb*1024*1024},fileFilter:(req,file,cb)=>{const ok=["image/jpeg","image/png","image/webp","application/pdf"].includes(file.mimetype); cb(ok?null:new Error("فقط تصویر یا PDF مجاز است"),ok);}});

app.post("/api/patients/:id/attachments",auth,role("admin","doctor","secretary"),uploader.array("files",10),async(req,res)=>{
  try{
    const patient=await q("SELECT id FROM patients WHERE id=$1",[req.params.id]); if(!patient.rowCount) throw new Error("بیمار یافت نشد");
    const out=[];
    for(const f of req.files){ const r=await q(`INSERT INTO attachments(patient_id,uploaded_by,original_name,stored_name,mime_type,size_bytes,storage_path)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,original_name,mime_type,size_bytes,created_at`,[req.params.id,req.session.user.id,f.originalname,f.filename,f.mimetype,f.size,f.path]); out.push(r.rows[0]); }
    res.status(201).json(out);
  }catch(e){res.status(400).json({error:e.message});}
});

app.get("/api/files/:id",auth,async(req,res)=>{
  const r=await q("SELECT * FROM attachments WHERE id=$1",[req.params.id]);
  if(!r.rowCount)return res.status(404).end();
  if(!fs.existsSync(r.rows[0].storage_path))return res.status(410).end();
  res.type(r.rows[0].mime_type).sendFile(path.resolve(r.rows[0].storage_path));
});

app.get("/api/schedules",auth,async(req,res)=>{
  const doctor=req.query.doctor_id||req.session.user.id;
  const r=await q("SELECT * FROM schedules WHERE doctor_id=$1 AND active=true ORDER BY weekday,start_time",[doctor]); res.json(r.rows);
});
app.post("/api/schedules",auth,role("doctor","admin"),async(req,res)=>{
  const doctor=req.session.user.role==="doctor"?req.session.user.id:req.body.doctor_id;
  const {weekday,start_time,end_time,slot_minutes=30}=req.body;
  const r=await q("INSERT INTO schedules(doctor_id,weekday,start_time,end_time,slot_minutes) VALUES($1,$2,$3,$4,$5) RETURNING *",[doctor,weekday,start_time,end_time,slot_minutes]); res.status(201).json(r.rows[0]);
});

app.get("/api/appointments",auth,async(req,res)=>{
  const doctor=req.query.doctor_id||req.session.user.id;
  const from=req.query.from||new Date().toISOString().slice(0,10);
  const r=await q(`SELECT a.*,p.full_name,p.mobile,p.medical_record_no FROM appointments a JOIN patients p ON p.id=a.patient_id
    WHERE a.doctor_id=$1 AND a.appointment_date >= $2 ORDER BY a.appointment_date,a.start_time LIMIT 200`,[doctor,from]); res.json(r.rows);
});
app.post("/api/appointments",auth,async(req,res)=>{
  try{
    const {patient_id,doctor_id,appointment_date,start_time,end_time,source="online",notes,payment_status="unpaid",payment_method="parsian",payment_transaction_id=null}=req.body;
    const d=doctor_id||req.session.user.id;
    if(source==="secretary" && !["secretary","doctor","admin"].includes(req.session.user.role)) return res.status(403).json({error:"دسترسی مجاز نیست"});
    const r=await q(`INSERT INTO appointments(patient_id,doctor_id,appointment_date,start_time,end_time,source,notes,created_by,payment_status,payment_method,payment_transaction_id,amount)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [patient_id,d,appointment_date,start_time,end_time,source,notes||null,req.session.user.id,payment_status,payment_method,payment_transaction_id,Number(req.body.amount||0)]);
    res.status(201).json(r.rows[0]);
  }catch(e){res.status(409).json({error:"این زمان قبلاً رزرو شده یا اطلاعات نوبت نامعتبر است"});}
});

async function collectBackup(){
  const tables=["users","patients","medical_records","schedules","appointments","visits","prescriptions","attachments"];
  const data={created_at:new Date().toISOString(),tables:{}};
  for(const t of tables){const r=await q(`SELECT * FROM ${t}`);data.tables[t]=r.rows;}
  const dir=path.join(backupDir,"backup-"+new Date().toISOString().replace(/[:.]/g,"-"));
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"backup.json"),JSON.stringify(data,null,2),"utf8");
  const files=await q("SELECT storage_path,stored_name FROM attachments");
  const adir=path.join(dir,"attachments");fs.mkdirSync(adir,{recursive:true});
  for(const f of files.rows) if(fs.existsSync(f.storage_path)) fs.copyFileSync(f.storage_path,path.join(adir,f.stored_name));
  return dir;
}
app.post("/api/admin/backup",auth,role("admin"),async(req,res)=>{
  try{
    const dir=await collectBackup();
    const zipPath=dir+".zip";
    await new Promise((resolve,reject)=>{const out=fs.createWriteStream(zipPath);const arc=archiver("zip",{zlib:{level:9}});out.on("close",resolve);arc.on("error",reject);arc.pipe(out);arc.directory(dir,false);arc.finalize();});
    res.download(zipPath,"pezeshkyar-backup.zip");
  }catch(e){res.status(500).json({error:"Backup ناموفق بود"});}
});
app.get("/api/admin/backup/excel",auth,role("admin"),async(req,res)=>{
  const wb=XLSX.utils.book_new();
  for(const t of ["patients","medical_records","appointments","visits","prescriptions","attachments"]){
    const r=await q(`SELECT * FROM ${t}`);
    const ws=XLSX.utils.json_to_sheet(r.rows);XLSX.utils.book_append_sheet(wb,ws,t.slice(0,31));
  }
  const out=path.join(backupDir,"pezeshkyar-"+Date.now()+".xlsx");XLSX.writeFile(wb,out);res.download(out,"pezeshkyar-backup.xlsx");
});
app.get("/api/admin/stats",auth,role("admin"),async(req,res)=>{
  const [p,a,v]=await Promise.all([q("SELECT count(*)::int n FROM patients"),q("SELECT count(*)::int n FROM appointments"),q("SELECT count(*)::int n FROM visits")]);
  res.json({patients:p.rows[0].n,appointments:a.rows[0].n,visits:v.rows[0].n});
});

const intervalHours=Number(process.env.BACKUP_INTERVAL_HOURS||0);
if(intervalHours>0) setInterval(()=>collectBackup().catch(console.error),intervalHours*3600*1000);

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:"خطای داخلی سرور"});});
init().then(()=>app.listen(PORT,()=>console.log(`Pezeshkyar running on ${PORT}`))).catch(e=>{console.error(e);process.exit(1);});
