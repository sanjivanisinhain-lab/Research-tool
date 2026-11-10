import fs from "node:fs"; import Papa from "papaparse"; import { DatabaseSync } from "node:sqlite";
const rows = Papa.parse(fs.readFileSync(process.argv[2],"utf8"),{header:true,skipEmptyLines:true}).data;
const db = new DatabaseSync(process.argv[3]);
const dump = JSON.stringify(["utterances","participants","sources","audit_log"].map(t=>db.prepare(`select * from ${t}`).all())).toLowerCase();
const leaks=new Set();
for (const r of rows){
  for (const tok of (r.Name||"").split(/\s+/)) if (tok.replace(/\W/g,"").length>=3 && dump.includes(tok.toLowerCase())) leaks.add("name:"+tok);
  const city=(r.City||"").toLowerCase(); if (city.length>=3 && dump.includes(city)) leaks.add("city:"+city);
  const m=(r["Mobile Number"]||"").trim(); if (m.length>=10 && dump.includes(m)) leaks.add("mobile:"+m.slice(0,3)+"…");
}
console.log("leaks:", leaks.size ? [...leaks].join(", ") : "none");
for (const t of ["studies","participants","sources","utterances"]) console.log(t, db.prepare(`select count(*) n from ${t}`).get().n);
console.log(JSON.stringify(db.prepare("select source_type,origin,quality,count(*) n from sources group by 1,2,3").all()));
