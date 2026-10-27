import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3001);
const dataRoot = fileURLToPath(new URL("../../data", import.meta.url));
createApp(dataRoot).listen(port, () =>
  console.log(`Signal Network server on http://localhost:${port}`),
);
