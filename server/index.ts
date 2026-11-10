import { openDb } from "./db";
import { createApp } from "./app";

const db = openDb();
const port = Number(process.env.PORT ?? 8787);
createApp(db).listen(port, "127.0.0.1", () => console.log(`API on http://127.0.0.1:${port}`));
