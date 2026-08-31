const host = "delta-witness-app.pages.dev";
const key = "delta-witness-2026-8f0c5a3d6e7b91ac";
const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList: [`https://${host}/`],
  }),
});
if (!response.ok) throw new Error(`IndexNow rejected Base app pulse: HTTP ${response.status} ${await response.text()}`);
console.log(`IndexNow accepted ${host}: HTTP ${response.status}`);
