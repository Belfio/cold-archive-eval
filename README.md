# Cold Archive

Personal cold storage for big, rarely-used files: originals go to **S3 Glacier
Deep Archive** (~$1.8/TB/month in London), and every file gets a small
**preview (~1% of its size)** in normal S3 so you can see what it is without
waiting for a restore. Goal: keep the laptop clean and the AWS bill tiny.

> Status (2026-11-15): storage live. **Mac app `coldarchive` shipped** (below). Web viewer
> (SST, plan 2) **live**: https://example.cloudfront.net

## Mac app

```bash
cd cold-archive
uv run coldarchive serve            # UI at the printed http://127.0.0.1:8765/... URL (token in the link)
uv run coldarchive add ~/path/to/big-file-or-folder
uv run coldarchive list
uv run coldarchive suggest          # big files untouched for 60+ days
uv run coldarchive delete-local <id> --yes   # permanent; re-checks S3 checksum first
uv run coldarchive delete <id>      # shows early-delete charge; add --yes to delete from S3
uv run coldarchive import           # rebuild local index from S3 manifests
```
Safety: local delete only if the upload is verified, the file is unchanged since
upload, it's on the same Mac, it's not in ~/Library or an app library, and a fresh
S3 HEAD confirms size + CRC64NVME + DEEP_ARCHIVE.

## How it works

```
 Mac ──(stream + checksum)──► s3://example-cold-archive/
                               ├─ originals/YYYY/MM/<id>/<file>   DEEP_ARCHIVE (12–48 h to restore)
                               ├─ previews/YYYY/MM/<id>/<files>   STANDARD     (instant)
                               └─ manifest/<id>.json              STANDARD     (all metadata)
```

- **Previews**: video → small watchable MP4 + poster; photo → scaled JPEG;
  PDF → first pages; mbox → index of every email (date/from/to/subject);
  folder/zip → full file listing + thumbnails; anything else → type/size/first KB.
  Hard cap: `min(1% of original, 50 MB)`.
- **Verification**: S3 computes a full-object CRC64NVME checksum; it must equal
  the one computed locally while reading the file. Only then is an item marked
  `verified`, and only verified items may be deleted locally (permanently).
- **Manifest** (`manifest/<id>.json`): id, kind, original path + machine, size,
  dates, sha256, crc64nvme, verification, preview keys, `min_storage_until`
  (Deep Archive bills a minimum of 180 days), estimated monthly cost, tags/notes.
- **Bucket**: `example-cold-archive`, `eu-west-2`, all public access
  blocked, SSE-S3 encryption, unfinished multipart uploads auto-aborted after 3 days.


## Access

- **Web viewer**: https://example.cloudfront.net — log in with your email (Cognito, single user, no sign-up). Browse/search, previews (video, photos, email index, folder listings), restore (emails you when ready), download restored originals, delete with early-delete charge shown. Code in `viewer/` (SST v3, stage `prod`, eu-west-2): `cd viewer && AWS_PROFILE=personal npx sst deploy --stage prod`.

- **AWS CLI**: profile `personal` (region `eu-west-2`). Check: `aws sts get-caller-identity --profile personal`.
- **Console**: S3 → `example-cold-archive` (London).
- Everything below assumes `export AWS_PROFILE=personal AWS_REGION=eu-west-2 B=example-cold-archive`.

## Raw AWS commands (without the app)

**See what's archived**
```bash
aws s3 ls s3://$B/manifest/
aws s3 cp s3://$B/manifest/<id>.json - | jq '{id, kind, bytes: .s3.bytes, verified: .verification.verified, min_storage_until}'
```

**Preview a file** (instant — previews are in Standard)
```bash
aws s3 ls s3://$B/previews/ --recursive | grep <id>
aws s3 presign s3://$B/previews/YYYY/MM/<id>/<file> --expires-in 900   # open the URL in a browser
```

**Upload / archive** — with previews + verification, use the app:
```bash
uv run coldarchive add ./file
```
Quick upload without preview/manifest (not recommended):
```bash
aws s3 cp ./file "s3://$B/originals/$(date +%Y/%m)/<id>/file" --storage-class DEEP_ARCHIVE --checksum-algorithm CRC64NVME
```

**Restore the original** (Bulk = cheapest, ≤48 h; Standard ≤12 h)
```bash
aws s3api restore-object --bucket $B --key "originals/…/<file>" \
  --restore-request '{"Days":7,"GlacierJobParameters":{"Tier":"Bulk"}}'
aws s3api head-object --bucket $B --key "originals/…/<file>" --query Restore   # ongoing-request="false" = ready
aws s3 cp "s3://$B/originals/…/<file>" .
```

**Delete an item** (original + previews + manifest; deleting before
`min_storage_until` still bills the remaining days of the 180)
```bash
aws s3 rm "s3://$B/originals/YYYY/MM/<id>/" --recursive
aws s3 rm "s3://$B/previews/YYYY/MM/<id>/" --recursive
aws s3 rm "s3://$B/manifest/<id>.json"
```

## Roadmap

1. **Mac uploader** (`coldarchive`, Python): localhost UI + CLI — pick files,
   previews, upload, verify, delete local copy, "big stale files" suggestions.
2. **Web viewer** (SST v3, single-user Cognito login): browse/search, previews,
   restore with email when ready, delete with early-delete cost warning, cost panel.
