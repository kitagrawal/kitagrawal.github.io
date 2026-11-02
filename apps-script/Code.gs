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
