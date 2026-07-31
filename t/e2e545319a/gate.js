/* ============================================================
   Passphrase gate config.

   To change the passphrase: open the app, expand "Set or change
   the passphrase" on the lock screen, type the new phrase, copy
   the hash it shows, and paste it below. That's the only edit.

   This is a CURTAIN, NOT A LOCK. This file is public and anyone
   can read the hash and bypass the check. It stops casual
   discovery and over-the-shoulder access. Your actual log lives
   in your browser's local storage and never touches this repo.
   ============================================================ */

const GATE_HASH = "7d7294148b743c06e0e6668f1e99b843afd19f7213cc1141433a8bbec81544ef";
const GATE_SALT = "focustracker.v1:";
