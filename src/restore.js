// بازیابی Backup سطح برنامه.
// فقط روی محیط امن و پس از تهیه Backup فعلی اجرا شود.
// روش: node src/restore.js /path/to/backup-folder
const fs=require("fs"),path=require("path");const {Pool}=require("pg");
const folder=process.argv[2];if(!folder){console.error("Usage: node src/restore.js BACKUP_FOLDER");process.exit(1)}
const data=JSON.parse(fs.readFileSync(path.join(folder,"backup.json"),"utf8"));const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
(async()=>{const c=await pool.connect();try{await c.query("BEGIN");for(const t of ["prescriptions","visits","attachments","appointments","medical_records","schedules","patients"]){if(data.tables[t]) await c.query(`TRUNCATE ${t} RESTART IDENTITY CASCADE`)}
const order=["patients","medical_records","schedules","appointments","visits","prescriptions","attachments","users"];
for(const t of order){const rows=data.tables[t]||[];for(const row of rows){const keys=Object.keys(row);const vals=keys.map(k=>row[k]);const placeholders=keys.map((_,i)=>`$${i+1}`).join(",");await c.query(`INSERT INTO ${t}(${keys.join(",")}) VALUES(${placeholders}) ON CONFLICT DO NOTHING`,vals)}}await c.query("COMMIT");console.log("Restore completed")}catch(e){await c.query("ROLLBACK");console.error(e);process.exitCode=1}finally{c.release();await pool.end()}})();
