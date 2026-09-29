# OTTv2 Deployment

Tai lieu nay ghi lai quy trinh deploy tu frontend den online backend.

## Kien truc

- Frontend React/Vite duoc build thanh file tinh va host tren Vercel.
- Online backend chay tren Cloudflare Worker.
- Trang thai phong va tran dau duoc luu trong Durable Objects.
- Vercel khong chay online backend.
- `OTT_INTERNAL_SECRET` chi ton tai tren Worker, khong duoc dua vao frontend.

Luong online:

1. Browser goi Worker qua `/control/create`, `/control/list`, `/control/join` va `/control/resume`.
2. Lobby Durable Object cap room allocation va ticket tam thoi.
3. Game Durable Object xu ly trang thai, dong ho va nuoc di.
4. Browser ket noi mot provider connection toi `/parties/main/<roomId>`.
5. Worker dung `OTT_INTERNAL_SECRET` de xac thuc cac capability giua Lobby va Game.

## Trang thai hien tai

- Vercel project: `lap-trinh-mang/ottv2`.
- Frontend production: <https://ottv2-two.vercel.app>.
- Deployment gan nhat da o trang thai `Ready`.
- Vercel Deployment Protection da tat de URL co the truy cap cong khai.
- Cloudflare Worker production chua duoc deploy.
- Cloudflare Wrangler chua dang nhap trong moi truong deploy.
- Frontend hien chua co `VITE_OTT_PLAYHTML_HOST` va `VITE_OTT_PLAYHTML_CONTROL_ENDPOINT`, nen online van unavailable.
- Ban deploy Vercel hien tai duoc build tu worktree dang co thay doi chua commit.

## Yeu cau

- Node.js >= 18.
- Vercel CLI da cai dat va dang nhap.
- Wrangler da cai trong repository qua `wrangler` dependency.
- Mot Cloudflare account co quyen deploy Worker, Durable Objects va secrets.
- Mot URL frontend HTTPS on dinh. URL hien tai la `https://ottv2-two.vercel.app`.

Kiem tra CLI:

```powershell
vercel --version
vercel whoami
npx --no-install wrangler --version
npx --no-install wrangler whoami
```

## Giai doan 1: Deploy frontend static

Frontend co the deploy truoc khi Worker san sang. Khi do local va AI mode van hoat dong, con online mode tu dong unavailable.

Build tu root repository:

```powershell
npm run build:web
```

Tao Vercel project moi neu chua co:

```powershell
vercel project add ottv2 --scope lap-trinh-mang
```

Deploy thu muc build:

```powershell
vercel deploy apps/web/dist --prod --yes --scope lap-trinh-mang --project ottv2
```

Kiem tra deployment:

```powershell
vercel inspect <deployment-url> --scope lap-trinh-mang --wait
vercel curl https://ottv2-two.vercel.app --scope lap-trinh-mang
```

Neu muc tieu la website cong khai, kiem tra Deployment Protection. Tat SSO protection khi can:

```powershell
vercel project protection ottv2 --scope lap-trinh-mang --json
vercel project protection disable ottv2 --sso --scope lap-trinh-mang
```

Khong dat `VITE_*` neu chi muon deploy frontend truoc. Khi do frontend khong gui request online den Worker.

## Giai doan 2: Dang nhap Cloudflare

Dang nhap bang OAuth trong trinh duyet:

```powershell
npx --no-install wrangler login
```

Kiem tra tai khoan:

```powershell
npx --no-install wrangler whoami
```

Khong gui mat khau, API token hoac secret qua chat. Neu lenh login bi timeout trong agent, chay lenh tren trong PowerShell cua nguoi dung de hoan tat OAuth.

## Giai doan 3: Cau hinh Worker production

File cau hinh deploy la:

```text
apps/worker/wrangler.jsonc
```

Them bien public origin o cap production trong `wrangler.jsonc`. Dung URL frontend that va khong co dau `/` o cuoi:

```jsonc
{
  "name": "ottv2-minimal",
  "main": "src/entry/ott-worker.ts",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "preview_urls": false,
  "vars": {
    "OTT_BROWSER_ORIGIN": "https://ottv2-two.vercel.app"
  }
}
```

Chi them `vars` vao config production. Khong copy nguyen file mau va khong ghi secret vao git.

Dat secret server-only. Wrangler se yeu cau nhap gia tri trong terminal:

```powershell
npx --no-install wrangler secret put OTT_INTERNAL_SECRET --config apps/worker/wrangler.jsonc
```

Khong dat `OTT_INTERNAL_SECRET` vao:

- `VITE_OTT_*`.
- Vercel frontend environment.
- URL, query string, page data, PlayHTML state hoac log.
- `wrangler.jsonc` trong repository.

`OTT_SPECTATOR_ENABLED` nen de trong hoac dat khac `"true"` cho production cho den khi co du evidence rollout spectator. Khong dung env `test` hoac `demo` de deploy production.

## Giai doan 4: Deploy Worker

Deploy tu root repository:

```powershell
npx --no-install wrangler deploy --config apps/worker/wrangler.jsonc
```

Wrangler se ap dung Durable Object migrations trong `apps/worker/wrangler.jsonc`. Luu lai URL Worker, vi du:

```text
https://ottv2-minimal.<cloudflare-account>.workers.dev
```

Khong dung URL local `127.0.0.1` trong frontend production.

## Giai doan 5: Build lai frontend voi Worker production

Control request production bat buoc dung HTTPS. Dat hai bien public bang cung Worker origin:

```powershell
$env:VITE_OTT_PLAYHTML_HOST = "https://ottv2-minimal.<cloudflare-account>.workers.dev"
$env:VITE_OTT_PLAYHTML_CONTROL_ENDPOINT = "https://ottv2-minimal.<cloudflare-account>.workers.dev"
npm run build:web
```

Deploy lai cung Vercel project:

```powershell
vercel deploy apps/web/dist --prod --yes --scope lap-trinh-mang --project ottv2
```


Neu doi domain frontend, cap nhat dong thoi:

1. `OTT_BROWSER_ORIGIN` tren Worker.
2. `VITE_OTT_PLAYHTML_HOST` trong build frontend.
3. `VITE_OTT_PLAYHTML_CONTROL_ENDPOINT` trong build frontend.

## Kiem tra sau deploy

Kiem tra control endpoint voi origin dung:

```powershell
curl.exe -i -X POST "https://<worker-url>/control/list" `
  -H "Origin: https://ottv2-two.vercel.app" `
  -H "Content-Type: application/json" `
  --data "{}"
```

Ket qua hop le la HTTP 200 va JSON co truong `rooms`. Neu origin sai, Worker se khong them CORS headers.

Kiem tra tren browser production:

- Mo frontend production bang hai browser profile tach biet.
- Tao phong bang profile A.
- Dung profile B join phong.
- Kiem tra mot nuoc di hop le propagate sang profile con lai.
- Kiem tra nuoc di sai bi tu choi.
- Reload va reconnect.
- Kiem tra disconnect grace va disconnect timeout.
- Kiem tra `leave` va timeout.
- Kiem tra local va AI van hoat dong khi Worker khong kha dung.
- Kiem tra secret khong xuat hien trong bundle, URL, storage public, page data hoac log.

Khong coi mot lenh deploy thanh production acceptance. Can evidence HTTPS runtime va manual two-profile acceptance truoc khi danh dau production ready.

## Cac loi thuong gap

### `You are not authenticated`

Chay:

```powershell
npx --no-install wrangler login
npx --no-install wrangler whoami
```

### `Project was not found in the current scope`

Kiem tra team va tao project dung scope:

```powershell
vercel teams ls
vercel project ls --scope lap-trinh-mang
vercel project add ottv2 --scope lap-trinh-mang
```

### Website yeu cau dang nhap Vercel

Deployment Protection dang bat. Kiem tra va tat SSO protection neu website can cong khai:

```powershell
vercel project protection ottv2 --scope lap-trinh-mang --json
vercel project protection disable ottv2 --sso --scope lap-trinh-mang
```

### Frontend bao `Online hien khong kha dung`

Kiem tra:

- Hai bien `VITE_OTT_*` co duoc dat truoc `npm run build:web` hay khong.
- Hai bien deu la HTTPS production URL.
- `OTT_BROWSER_ORIGIN` tren Worker trung khop origin frontend.
- `OTT_INTERNAL_SECRET` da duoc dat bang `wrangler secret put`.
- Worker da deploy dung `apps/worker/wrangler.jsonc`.
- Browser dang tai deployment moi nhat, khong phai cache cu.

### Worker tra `404` hoac `503`

- `404` co the do path khong nam trong allowlist hoac spectator dang tat.
- `503` co the do Game Durable Object initialization that bai.
- Kiem tra dung URL `/control/...`, HTTPS, origin va secret.
- Xem log Worker bang Wrangler sau khi deploy.

## Nguyen tac an toan

- Khong dung Vercel de thay the Worker backend.
- Khong tao WebSocket thu hai trong browser.
- Khong dua game state vao page data, presence, cursor, URL hoac public state.
- Khong dung internal payload marker tu client de authorization.
- Khong commit `.dev.vars`, secret, token hoac credential.
- Khong bat spectator production khi chua co evidence rollout.
- Khi Worker chua san sang, local va AI mode phai van hoat dong doc lap.
