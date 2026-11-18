# Put the Office Daily Cash Ledger on GitHub (backup + launch from GitHub)

## 1. First, understand where your data is

GitHub will hold your **code**, never your **data**. Your ledger entries live in:

| Place | What it is | Survives losing the PC / clearing the browser? |
|---|---|---|
| Browser storage (IndexedDB) | The main copy, **separate on every browser and every web address** | No |
| Cloud Sync (Firestore) | Optional copy, only if you set up a sync code | Yes, but a mistaken delete syncs everywhere |
| Google Drive Backup | Optional, only if you connected it | Yes |
| Exported JSON file | Settings -> Backup & Export -> **Export Backup** | Yes, if you keep the file safe |

Because the data belongs to a web address, **the GitHub link will start empty**.
It will not see what is stored at `office-cash-ledger.web.app`.

## 2. BEFORE you switch: save your data

On the current live site: **Settings -> Backup & Export -> Export Backup**.
Keep the `.json` file somewhere safe (email it to yourself, put it on Drive/USB).
Later, on the new GitHub link, use the restore option in the same Settings section.
If you already use Cloud Sync, you can instead Join with the same sync code on
the new link and press Sync Now.

## 3. Upload the code to GitHub (one time)

1. Create a free account at github.com, then **New repository**.
   Name it e.g. `office-cash-ledger`. Leave "Add a README" **unticked**.
2. Double-click **PUSH-TO-GITHUB.bat** in this folder. Paste the repository
   address when asked, and sign in to GitHub when the window opens.
   (Your `.env` file is ignored and is never uploaded.)

## 4. Turn on publishing

1. In the repo: **Settings -> Pages -> Source: GitHub Actions**.
2. Open the **Actions** tab. The "Deploy to GitHub Pages" job runs automatically
   (about 1-2 minutes). When it is green, your link is
   `https://YOURNAME.github.io/office-cash-ledger/`.

## 5. Only if you use Cloud Sync

Copy the six values from your `.env` file into
**Settings -> Secrets and variables -> Actions -> Variables tab -> New repository variable**,
using exactly these names:

`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
`VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`

Then in the Firebase console: **Authentication -> Settings -> Authorized domains ->
Add domain** -> `YOURNAME.github.io`. Without this, sync sign-in is blocked on the new link.
Re-run the job (Actions -> Deploy to GitHub Pages -> Run workflow).

If you use **Google Drive Backup**: in Google Cloud Console, open your OAuth Client ID
and add `https://YOURNAME.github.io` under **Authorized JavaScript origins**.

## 6. Updating later

Change the files, then double-click **PUSH-TO-GITHUB.bat** again. GitHub rebuilds
and republishes automatically. Every version stays in GitHub's history, so the
"which zip was the final one?" problem goes away.

## 7. Public or private repository?

- **Free GitHub plan:** Pages needs a **public** repo. The repo contains no ledger
  data, but the app code is visible to anyone, and anyone can open the site
  (they see an empty app; your data stays in your browser or your sync group).
- **Want the code private?** Keep it private on GitHub purely as a backup and keep
  hosting on Firebase. Pages from a private repo needs a paid plan.
