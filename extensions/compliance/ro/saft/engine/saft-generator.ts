/**
 * SAF-T XML Generator for Romania (OECD Standard Audit File for Tax)
 * Compliant with ANAF D.394 / SAF-T RO specification
 */

export interface SAFTAccount {
  code: string;
  description: string;
  account_type: string;
}

export interface SAFTJournalEntry {
  id: string;
  account_code: string;
  entry_date: string;
  description: string;
  debit: number;
  credit: number;
  document_number?: string;
}

export interface SAFTData {
  company_name: string;
  company_cui: string;
  company_address?: string;
  period_start: string;
  period_end: string;
  accounts: SAFTAccount[];
  entries: SAFTJournalEntry[];
}

function escapeXml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDate(d: string): string {
  return d.split('T')[0];
}

export function generateSAFTXML(data: SAFTData): string {
  const accounts = data.accounts
    .map(
      (acc) => `
      <Account>
        <AccountID>${escapeXml(acc.code)}</AccountID>
        <AccountDescription>${escapeXml(acc.description)}</AccountDescription>
        <AccountType>${escapeXml(acc.account_type)}</AccountType>
      </Account>`,
    )
    .join('\n');

  // Group entries by journal (by document_number prefix or just one journal)
  const totalDebit = data.entries.reduce((s, e) => s + Number(e.debit), 0);
  const totalCredit = data.entries.reduce((s, e) => s + Number(e.credit), 0);

  const lines = data.entries
    .map(
      (entry, i) => `
        <Line>
          <RecordID>${escapeXml(entry.id)}</RecordID>
          <AccountID>${escapeXml(entry.account_code)}</AccountID>
          <Description>${escapeXml(entry.description)}</Description>
          <DebitAmount>
            <Amount>${Number(entry.debit).toFixed(2)}</Amount>
          </DebitAmount>
          <CreditAmount>
            <Amount>${Number(entry.credit).toFixed(2)}</Amount>
          </CreditAmount>
          ${entry.document_number ? `<SourceDocumentID>${escapeXml(entry.document_number)}</SourceDocumentID>` : ''}
        </Line>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<AuditFile xmlns="urn:StandardAuditFile-Taxation-Financial:RO"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">

  <Header>
    <AuditFileVersion>2.0</AuditFileVersion>
    <AuditFileCountry>RO</AuditFileCountry>
    <AuditFileDateCreated>${new Date().toISOString().split('T')[0]}</AuditFileDateCreated>
    <SoftwareCompanyName>Zveltio</SoftwareCompanyName>
    <SoftwareID>Zveltio BaaS</SoftwareID>
    <SoftwareVersion>2.0</SoftwareVersion>
    <Company>
      <RegistrationNumber>${escapeXml(data.company_cui)}</RegistrationNumber>
      <Name>${escapeXml(data.company_name)}</Name>
      ${
        data.company_address
          ? `<Address>
        <StreetName>${escapeXml(data.company_address)}</StreetName>
        <Country>RO</Country>
      </Address>`
          : ''
      }
    </Company>
    <DefaultCurrencyCode>RON</DefaultCurrencyCode>
    <SelectionCriteria>
      <SelectionStartDate>${formatDate(data.period_start)}</SelectionStartDate>
      <SelectionEndDate>${formatDate(data.period_end)}</SelectionEndDate>
    </SelectionCriteria>
  </Header>

  <MasterFiles>
    <GeneralLedgerAccounts>
      ${accounts}
    </GeneralLedgerAccounts>
  </MasterFiles>

  <GeneralLedgerEntries>
    <NumberOfEntries>${data.entries.length}</NumberOfEntries>
    <TotalDebit>${totalDebit.toFixed(2)}</TotalDebit>
    <TotalCredit>${totalCredit.toFixed(2)}</TotalCredit>
    <Journal>
      <JournalID>GEN</JournalID>
      <Description>General Ledger</Description>
      <Type>GL</Type>
      ${lines}
    </Journal>
  </GeneralLedgerEntries>

</AuditFile>`;
}
