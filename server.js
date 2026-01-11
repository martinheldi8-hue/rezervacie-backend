const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- INIT DB ---
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      fields TEXT[] NOT NULL,
      group_name TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      time TIMESTAMP NOT NULL,
      action TEXT NOT NULL,
      detail JSONB NOT NULL
    )
  `);
}

initDb().catch(console.error);

// --- HELPERS ---
function timeToMinutes(t){
  const [h,m] = t.split(':').map(Number);
  return h*60 + m;
}
function overlaps(aStart,aEnd,bStart,bEnd){
  return aStart < bEnd && bStart < aEnd;
}

// --- API ---
function toIsoDateLocal(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function addDaysISO(dateStr, add){
  const d = new Date(dateStr + 'T12:00:00'); // 12:00 kvôli DST/UTC posunom
  d.setDate(d.getDate() + add);
  return toIsoDateLocal(d);
}
app.get('/health', (req,res)=>{
  res.json({ ok:true, time: new Date().toISOString() });
});

// ✅ NORMALIZOVANÝ SELECT
const SELECT_RESERVATIONS = `
  SELECT
    id,
    date,
    start_time AS start,
    end_time   AS end,
    fields,
    group_name AS group
  FROM reservations
`;

// GET reservations
app.get('/reservations', async (req,res)=>{
  try{
    const { date } = req.query;
    const result = date
      ? await pool.query(`${SELECT_RESERVATIONS} WHERE date=$1`, [date])
      : await pool.query(SELECT_RESERVATIONS);

    res.json(result.rows);
  }catch(err){
    console.error('GET /reservations error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
// GET reservations for whole week (1 request)
// /reservations/week?start=YYYY-MM-DD   (start = pondelok)
app.get('/reservations/week', async (req,res)=>{
  try{
    const { start } = req.query;
    if(!start) return res.status(400).json({ error: 'Missing start (YYYY-MM-DD)' });

    const dates = Array.from({length:7}, (_,i)=>addDaysISO(start, i));

    const result = await pool.query(
      `${SELECT_RESERVATIONS} WHERE date = ANY($1::text[])`,
      [dates]
    );

    res.json(result.rows);
  }catch(err){
    console.error('GET /reservations/week error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// CREATE reservation
app.post('/reservations', async (req,res)=>{
  const { date,start,end,fields,group } = req.body;

  const s = timeToMinutes(start);
  const e = timeToMinutes(end);

  const existing = await pool.query(
    'SELECT start_time,end_time,fields FROM reservations WHERE date=$1',
    [date]
  );

  for(const r of existing.rows){
    if(overlaps(
      s,e,
      timeToMinutes(r.start_time),
      timeToMinutes(r.end_time)
    )){
      for(const f of fields){
        if(r.fields.includes(f)){
          return res.status(400).json({ error:'Kolízia rezervácie' });
        }
      }
    }
  }

  const insert = await pool.query(
    `
    INSERT INTO reservations
    (date,start_time,end_time,fields,group_name)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING
      id,
      date,
      start_time AS start,
      end_time   AS end,
      fields,
      group_name AS group
    `,
    [date,start,end,fields,group]
  );

  await pool.query(
    'INSERT INTO audit_log (time,action,detail) VALUES ($1,$2,$3)',
    [new Date(), 'CREATE', insert.rows[0]]
  );

  res.json(insert.rows[0]);
});

// UPDATE reservation
app.put('/reservations/:id', async (req,res)=>{
  const id = Number(req.params.id);
  const { date,start,end,fields,group } = req.body;

  const update = await pool.query(
    `
    UPDATE reservations
    SET date=$1,start_time=$2,end_time=$3,fields=$4,group_name=$5
    WHERE id=$6
    RETURNING
      id,
      date,
      start_time AS start,
      end_time   AS end,
      fields,
      group_name AS group
    `,
    [date,start,end,fields,group,id]
  );

  await pool.query(
    'INSERT INTO audit_log (time,action,detail) VALUES ($1,$2,$3)',
    [new Date(), 'UPDATE', update.rows[0]]
  );

  res.json(update.rows[0]);
});

// DELETE reservation
app.delete('/reservations/:id', async (req,res)=>{
  const id = Number(req.params.id);
  await pool.query('DELETE FROM reservations WHERE id=$1',[id]);
  await pool.query(
    'INSERT INTO audit_log (time,action,detail) VALUES ($1,$2,$3)',
    [new Date(), 'DELETE', { id }]
  );
  res.json({ ok:true });
});

// AUDIT LOG
app.get('/audit', async (req,res)=>{
  const result = await pool.query(
    'SELECT * FROM audit_log ORDER BY time DESC'
  );
  res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('Server beží na porte', PORT));

