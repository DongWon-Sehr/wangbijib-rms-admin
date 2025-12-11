class BranchService {
  constructor() {
    this.ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    this.sheet = this.ss.getSheetByName(SHEET_NAMES.BRANCH);

    this.headers = this.sheet.getRange(1, 1, 1, this.sheet.getLastColumn()).getValues()[0];
  }

  getBranch(id) {
    const rows = this.sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === id) {
        const row = rows[i];
        const obj = {};

        // row → columnName: value 형태로 객체 변환
        this.headers.forEach((header, idx) => {
          obj[header] = row[idx];
        });

        return { row, obj };
      }
    }

    return null;
  }
}