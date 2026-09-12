# Lot 2 — frontières de protocole

## État

- Base exacte : `0c4f3f3912a6ad20cda7a0e90fc0378a73528137`
- Branche/worktree : `fix/hardening-20260912` dans `C:\Users\iront\.buzz\.scratch\agy-reviewed-integration-20260911T221144Z`
- Commit d’implémentation : `94fb1d1` (`fix(protocol): bound ACP and provider frames`)
- WIP de référence : `C:\Users\iront\.buzz\.scratch\agy-protocol-resume-20260911T221144Z`, HEAD `fed8e1de48f1304d7e653c990a3e1f3953fc09a1`, conservé inchangé (son état de travail est préservé).
- Publication, poussée, release et installation runtime : aucune.

## Changements

- `src/frame-codec.js` fournit un décodeur NDJSON incrémental borné en octets, réutilisable pour ACP et le fournisseur, avec UTF-8 fatal, fragmentation multioctet, dépassement immédiat avant newline, rejet EOF/troncature et budgets UTF-8 cumulatifs.
- `src/acp-server.js` valide les formes JSON-RPC avant déréférencement, distingue notifications valides et requêtes malformées sans ID, refuse les IDs non finis/non primitifs, borne l’entrée et rend le nettoyage des tâches insensible aux rejets.
- `src/agy-session.js` borne les lignes fournisseur, les réponses terminales et les événements différés (compte et octets), refuse les payloads `step_update` invalides, traite UTF-8 invalide/EOF sans tour suspendu et conserve les transitions existantes.
- `bin/agy-buzz-steer-hook.js` borne stdin et valide le contenu UTF-8 après fragments ; le test exerce le vrai bridge synthétique et vérifie le texte injecté.
- `src/delivery/identity.js` refuse plusieurs clés publiques distinctes, accepte les répétitions identiques et conserve le `spawnFn` injecté. `src/steering.js` et Doctor partagent le parseur booléen explicite (`true`, `'true'`, `'1'`).
- `package.json` et `docs/PROTOCOL_LIMITS.md` incluent le nouveau module et documentent les limites. Les fichiers Task 1 (`src/delivery/outbox.js`, `src/doctor.js`, `src/status.js`) ne sont pas modifiés.
- L’assertion `session.buffer` du test lifecycle a été retirée car ce champ interne a été remplacé par le décodeur borné ; la perte de contexte, l’EOF et l’absence de replay restent testés par des comportements observables.

## Preuves

- RED WIP historique reproduit par main : `C:\Users\iront\.buzz\WORK_LOGS\AGY_20260912_PROTOCOL_WIP_BASELINE.log` (2 pass, 4 défauts connus). La note `00-red-wip-baseline.log` est explicitement un résumé, pas une sortie brute.
- RED brut avant production : `C:\Users\iront\.buzz\WORK_LOGS\artifacts\agy-hardening-20260912-protocol\01-red-target-tests.raw.log`.
- Régression EOF UTF-8 : `11-red-provider-eof-utf8.raw.log` puis `12-green-provider-eof-utf8.raw.log` (21/21 pass).
- Recheck ciblé lifecycle/codec/session : `07-green-lifecycle-protocol.raw.log` (35/35 pass).
- Suite finale : `npm test`, 429 tests, 426 pass, 0 échec, 3 skips symlink Windows ; sortie brute et code de sortie 0 : `C:\Users\iront\.buzz\WORK_LOGS\artifacts\agy-hardening-20260912-protocol\13-full-suite-final.raw.log`.
- Paquet extrait : `node scripts/package-smoke.mjs`, handshake ACP, doctor, recovery, setup, modèles, manage et native lock PASS, aucun appel fournisseur/publication ; sortie brute et code de sortie 0 : `C:\Users\iront\.buzz\WORK_LOGS\artifacts\agy-hardening-20260912-protocol\14-package-smoke-final.raw.log`.
- `git diff --cached --check` est passé avant commit.

## Limites

Les trois skips de la suite complète concernent la création de symlinks sous le compte Windows courant. Aucun fournisseur Agy/Buzz réel, secret, réseau externe, runtime installé, harnais, service Cinebot/8787 ou changement lifecycle Task 3 n’a été utilisé ou modifié. Les journaux bruts sont conservés hors dépôt dans le répertoire d’artefacts indiqué.
