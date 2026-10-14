# Déployer sur Vercel (plan Hobby) + Neon

> Préparé mais **jamais déployé depuis cet environnement** : suis les étapes et vérifie `/api/health` après le premier déploiement.

## 1. Base de données Neon
1. Crée un projet Neon (région proche de ta région Vercel).
2. Récupère deux chaînes de connexion :
   - **Directe** (sans `-pooler` dans l'hôte) → `MIGRATION_DATABASE_URL` (compte propriétaire, ex. `neondb_owner`).
   - **Poolée** (hôte avec `-pooler`) → servira à `DATABASE_URL`, mais avec l'utilisateur `fluentra_app` (étape 2).
3. Garde `?sslmode=require` dans les deux.

## 2. Migrations (depuis ton poste, pas depuis Vercel)
```bash
export MIGRATION_DATABASE_URL="postgres://neondb_owner:…@ep-xxx.region.aws.neon.tech/neondb?sslmode=require"
export APP_DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"   # garde-le !
npm ci && npm run db:migrate
```
Cela crée le schéma, les politiques RLS et le rôle **non-superuser** `fluentra_app` avec ce mot de passe.
N'exécute pas `db:reset` ni `db:seed` en production. (Pour une démo, `db:seed` est possible sur une base de test seulement.)

Construis ensuite `DATABASE_URL` : même hôte **poolé**, utilisateur `fluentra_app`, mot de passe `APP_DB_PASSWORD`.
Il ne doit **jamais** être l'utilisateur propriétaire, sinon le Row Level Security serait contourné.

## 3. Variables d'environnement Vercel
| Variable | Valeur |
|---|---|
| `DATABASE_URL` | URL poolée, utilisateur `fluentra_app` |
| `APP_URL` | `https://ton-domaine.vercel.app` (ou domaine perso) |
| `APP_SECRET` | `openssl rand -base64 48` |
| `CRON_SECRET` | `openssl rand -base64 32` |
| `TRUST_PROXY` | `true` (IP client correcte pour les limites de débit) |
| `SMTP_HOST/PORT/USER/PASS/FROM` | ton relais email (Resend, Brevo…) |
| `DEV_SIMULATE_NOTIFICATIONS` | ne pas définir |

Sur Vercel, `VERCEL=1` est défini automatiquement : le stockage des images passe en base (`STORAGE_DRIVER=db`), le flux SSE est désactivé (l'app bascule en rafraîchissement automatique toutes les 30 s) et le pool de connexions est réduit à 3.

## 4. Tâches de fond (plan Hobby)
Vercel Hobby n'autorise que des crons **quotidiens** (`vercel.json` contient un tick à 04:00 UTC). Pour des rappels, automatisations et relances d'emails à ~5 min :
- le workflow `.github/workflows/tick.yml` appelle `POST /api/cron/tick` toutes les 5 minutes (GitHub peut retarder de quelques minutes) ;
- dans GitHub → Settings → Secrets → Actions, ajoute `APP_URL` et `CRON_SECRET` (même valeur que sur Vercel).

## 5. Limites connues sur cette configuration
- Mise à jour en direct par polling (30 s) au lieu de SSE.
- Images stockées en base (2 Mo max chacune) : correct pour logos/photos, pas pour un gros volume.
- Les durées de fonction Hobby sont limitées ; le tick traite 50 tâches par appel.
- Aucun paiement en ligne (voir `docs/STATUS.md`).

## Sans cloner le projet : migrer via GitHub Actions
1. GitHub → dépôt → Settings → Secrets and variables → Actions → *New repository secret* :
   - `MIGRATION_DATABASE_URL` : URL Neon du propriétaire, hôte **direct** (sans `-pooler`), avec `?sslmode=require`.
   - `APP_DB_PASSWORD` : mot de passe de ton choix (≥ 20 caractères, sans `/ + =`) pour le rôle `fluentra_app`. Note-le pour `DATABASE_URL`.
2. Onglet **Actions** → *Migrate production database* → *Run workflow* → saisis `MIGRATE`.
3. Le workflow applique les migrations et crée le rôle `fluentra_app`. Il ne charge jamais de données de démo.
