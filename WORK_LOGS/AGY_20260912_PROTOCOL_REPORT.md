# Rapport Task 2 — frontières de protocole

Implémentation livrée dans `94fb1d1` sur la base `0c4f3f3912a6ad20cda7a0e90fc0378a73528137`.

Le lot ajoute le décodeur NDJSON partagé et borné pour ACP/fournisseur, les limites de trames, réponses et événements différés, le contrôle UTF-8/EOF, la validation des formes JSON-RPC et des payloads fournisseur, la limite stdin du hook, le refus d’identités ambiguës et le parseur booléen commun runtime/Doctor. Le packaging et `docs/PROTOCOL_LIMITS.md` sont mis à jour. Aucun fichier Task 1 ni lifecycle Task 3 n’a été modifié.

Validation : `npm test` = 429 tests, 426 PASS, 0 FAIL, 3 SKIP symlink Windows ; `node scripts/package-smoke.mjs` = paquet extrait, handshake/doctor/recovery/setup/models/manage/native lock PASS, zéro fournisseur/publication. Les sorties brutes et codes de sortie sont dans `C:\Users\iront\.buzz\WORK_LOGS\artifacts\agy-hardening-20260912-protocol\13-full-suite-final.raw.log` et `14-package-smoke-final.raw.log`.

Limites : skips symlink liés au privilège du compte courant ; aucun fournisseur réel, secret, runtime installé, publication, push ou service externe. WIP historique conservé inchangé.
