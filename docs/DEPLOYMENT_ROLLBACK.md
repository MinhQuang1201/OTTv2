# Deployment va Rollback OTTv2

Tai lieu nay huong dan phat hanh ban moi va quay lai ban stable khi co loi.

## Nguyen Tac

- Moi lan phat hanh phai co git tag hoac commit stable.
- Luu lai Vercel deployment URL va Cloudflare Worker version ID.
- Frontend Vercel va Worker Cloudflare rollback doc lap.
- Khong bat spectator production neu chua co evidence runtime acceptance.
- Khong commit secret. `OTT_INTERNAL_SECRET` chi nam tren Worker.
- Durable Object state khong tu dong quay lui theo code rollback.

## Truoc Khi Deploy

Chay tu root repository:

```powershell
rtk npm test
rtk npm run test:web
rtk npm run typecheck:web
rtk npm run build:web
rtk git diff --check
```

Tao moc stable:

```powershell
rtk git tag v2026.09.30-stable
```

Luu commit/tag nay vao release notes cung voi:

- Git commit SHA.
- Vercel deployment URL stable.
- Cloudflare Worker version ID stable.
- Ket qua smoke test.

## Deploy Worker

Kiem tra dang nhap:

```powershell
rtk npx --no-install wrangler whoami
```

Dat secret server-only neu chua co:

```powershell
rtk npx --no-install wrangler secret put OTT_INTERNAL_SECRET --config apps/worker/wrangler.jsonc
```

Deploy Worker:

```powershell
rtk npx --no-install wrangler deploy --config apps/worker/wrangler.jsonc
```

Luu version/deployment hien tai:

```powershell
rtk npx --no-install wrangler versions list --config apps/worker/wrangler.jsonc
rtk npx --no-install wrangler deployments list --config apps/worker/wrangler.jsonc
```

Kiem tra control endpoint voi origin dung:

```powershell
curl.exe -i -X POST "https://<worker-url>/control/list" `
  -H "Origin: https://ottv2-two.vercel.app" `
  -H "Content-Type: application/json" `
  --data "{}"
```

## Deploy Frontend

Build voi Worker production:

```powershell
$env:VITE_OTT_PLAYHTML_HOST = "https://<worker-url>"
$env:VITE_OTT_PLAYHTML_CONTROL_ENDPOINT = "https://<worker-url>"
rtk npm run build:web
```

Deploy Vercel:

```powershell
rtk vercel deploy apps/web/dist --prod --yes --scope lap-trinh-mang --project ottv2
```

Luu deployment URL tu output cua Vercel. Khong coi deploy thanh acceptance. Can kiem tra browser sau deploy.

## Rollback Frontend

Neu loi nam o frontend, rollback ve deployment stable:

```powershell
rtk vercel rollback <stable-deployment-url> --scope lap-trinh-mang
```

Kiem tra trang thai rollback:

```powershell
rtk vercel rollback status --scope lap-trinh-mang
```

## Rollback Worker

Neu loi nam o Worker, rollback ve version stable:

```powershell
rtk npx --no-install wrangler rollback <stable-version-id> --config apps/worker/wrangler.jsonc
```

Kiem tra deployment sau rollback:

```powershell
rtk npx --no-install wrangler deployments list --config apps/worker/wrangler.jsonc
```

Rollback Worker chi thay code/binding version dang phuc vu. Durable Object data, migration va resource lien quan khong duoc khoi phuc tu dong.

## Thu Tu Xu Ly Su Co

### Chi loi frontend

1. Dung rollout frontend moi.
2. Rollback Vercel ve stable deployment.
3. Kiem tra lai local/AI va online UI.

### Chi loi Worker

1. Dung rollout Worker moi.
2. Rollback Worker ve stable version.
3. Kiem tra `/control/list`, create/join/resume va provider connection.
4. Neu frontend moi khong tuong thich Worker stable, rollback frontend tiep.

### Loi ca hai phia

1. Rollback Worker ve stable version.
2. Rollback Vercel ve stable deployment.
3. Xac nhan frontend va Worker cung mot release pair.
4. Chay lai smoke test hai profile.

## Durable Objects Va Migration

Khong rollback code neu release vua thay doi schema theo cach code stable khong doc duoc du lieu hien tai.

Dung quy trinh expand-contract:

1. Them field/schema moi nhung van giu code cu doc duoc.
2. Deploy code tuong thich ca schema cu va moi.
3. Migrate/backfill neu can.
4. Chi xoa field cu o mot release sau khi khong con code cu.

Neu migration da tao lifecycle thay doi cho Durable Object, uu tien forward fix tuong thich thay vi rollback mu.

## Checklist Sau Rollback

- [ ] Vercel dang phuc vu deployment stable.
- [ ] Worker dang phuc vu version stable.
- [ ] `/control/list` tra ve response hop le.
- [ ] Create/join/resume hoat dong.
- [ ] Hai profile nhan duoc state authoritative.
- [ ] Local va AI van hoat dong.
- [ ] Spectator tra ve active catalog va read-only state neu dang bat; fail-closed sau khi rollback neu can.
- [ ] Khong co secret trong frontend bundle.
- [ ] Ghi lai thoi diem, ly do, deployment URL va version ID.

## OTTv2 Hien Tai

- Worker production da deploy theo `DEPLOYMENT.md`: `d1d44b8e-9fd0-4cc8-a3cd-cec43ba0047d`.
- `OTT_SPECTATOR_ENABLED` dang bat trong production; rollback co the tat bang mot deploy config truoc do.
- `.dev.vars` la local-only va khong duoc commit.
- Khong dung test/demo Wrangler config de deploy production.
