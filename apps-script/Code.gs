/**
 * Mailing-list collector. Paste into Extensions -> Apps Script of a Google Sheet,
 * then Deploy -> New deployment -> Web app (Execute as: Me, Access: Anyone).
 * Every sign-up becomes one row in the "Subscribers" tab. Download it any time via
 * File -> Download -> CSV or Microsoft Excel (.xlsx).
 */
var SHEET_NAME = 'Subscribers';
var HEADERS = ['Signed up', 'Email', 'Name', 'Status', 'Source', 'Last updated'];
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (data.action === 'stripe_sync') return out_(stripeSync_(data));
    var email = String(data.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return out_({ ok: false, error: 'invalid email' });

    var sheet = getSheet_();
    var last = sheet.getLastRow();
    var emails = last > 1 ? sheet.getRange(2, 2, last - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
    var idx = emails.indexOf(email);
    var now = new Date();

    if (data.action === 'returned_from_checkout') {
      // Informational only: the visitor landed on the thank-you page after Stripe checkout.
      // Confirm real payments in your Stripe dashboard.
      if (idx >= 0) {
        sheet.getRange(idx + 2, 4).setValue('returned_from_checkout');
        sheet.getRange(idx + 2, 6).setValue(now);
      }
      return out_({ ok: true });
    }

    if (idx >= 0) {                       // already on the list: just touch the timestamp
      sheet.getRange(idx + 2, 6).setValue(now);
      return out_({ ok: true, duplicate: true });
    }

    sheet.appendRow([now, email, clean_(data.name, 100), 'pending_payment', clean_(data.source, 50), now]);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Daily sync from the GitHub Action (scripts/stripe-sync.mjs). Sets Status to the
// Stripe subscription status on rows whose email is already in the Sheet. Emails
// not in the Sheet are skipped. Needs Script Property SYNC_TOKEN, equal to the
// repo secret SHEET_SYNC_TOKEN.
var STRIPE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'incomplete_expired', 'canceled'];

function stripeSync_(data) {
  var expected = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!expected || data.token !== expected) return { ok: false, error: 'unauthorized' };
  if (!Array.isArray(data.subscribers)) return { ok: false, error: 'no subscribers list' };

  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return { ok: true, updated: 0, notFound: data.subscribers.length };

  // Read Email..Status, but write only Status and Last updated: rewriting other
  // cells would drop the ' that clean_() adds and re-enable formulas.
  var rows = sheet.getRange(2, 2, last - 1, 3).getValues();
  var rowByEmail = {};
  rows.forEach(function (r, i) { rowByEmail[String(r[0]).toLowerCase()] = i; });

  var now = new Date(), updated = 0, notFound = 0;
  data.subscribers.forEach(function (s) {
    var email = String(s && s.email || '').trim().toLowerCase();
    var status = STRIPE_STATUSES.indexOf(s && s.status) >= 0 ? s.status : null;
    if (!status) return;
    var i = rowByEmail[email];
    if (i === undefined) { notFound++; return; }
    if (rows[i][2] === status) return;               // Status unchanged
    rows[i][2] = status;
    sheet.getRange(i + 2, 4).setValue(status);       // column D: Status
    sheet.getRange(i + 2, 6).setValue(now);          // column F: Last updated
    updated++;
  });
  return { ok: true, updated: updated, notFound: notFound };
}

function doGet() { return out_({ ok: true, service: 'mailing-list' }); }

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

// Trim, cap length, and neutralise spreadsheet formula injection (=, +, -, @ at the start).
function clean_(v, max) {
  var s = String(v == null ? '' : v).trim().slice(0, max);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
