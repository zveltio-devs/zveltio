/**
 * UBL 2.1 XML Invoice Generator for Romanian e-Factura (ANAF)
 * Compliant with RO_CIUS profile (EN 16931)
 */

export interface InvoiceLine {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  vat_rate: number;  // 0, 5, 9, 19
  vat_amount: number;
  line_total: number;
}

export interface InvoiceData {
  invoice_number: string;
  invoice_date: string;
  due_date?: string;
  currency: string;

  seller_name: string;
  seller_cui: string;
  seller_reg_com?: string;
  seller_address?: string;
  seller_iban?: string;
  seller_bank?: string;

  buyer_name: string;
  buyer_cui?: string;
  buyer_address?: string;

  lines: InvoiceLine[];

  subtotal: number;
  vat_total: number;
  total: number;
}

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDate(d: string): string {
  return d.split('T')[0]; // ISO date only
}

export function generateUBLXML(invoice: InvoiceData): string {
  const lines = invoice.lines;

  // Group VAT by rate
  const vatGroups: Record<number, { taxable: number; vat: number }> = {};
  for (const line of lines) {
    if (!vatGroups[line.vat_rate]) vatGroups[line.vat_rate] = { taxable: 0, vat: 0 };
    vatGroups[line.vat_rate].taxable += line.line_total - line.vat_amount;
    vatGroups[line.vat_rate].vat += line.vat_amount;
  }

  const taxSubtotals = Object.entries(vatGroups)
    .map(([rate, amounts]) => `
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${invoice.currency}">${amounts.taxable.toFixed(2)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${invoice.currency}">${amounts.vat.toFixed(2)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID>${Number(rate) === 0 ? 'Z' : 'S'}</cbc:ID>
          <cbc:Percent>${rate}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>`)
    .join('\n');

  const invoiceLines = lines.map((line, i) => `
    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${escapeXml(line.unit)}">${line.quantity}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${invoice.currency}">${(line.line_total - line.vat_amount).toFixed(2)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${line.vat_rate === 0 ? 'Z' : 'S'}</cbc:ID>
          <cbc:Percent>${line.vat_rate}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${invoice.currency}">${line.unit_price.toFixed(2)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice
  xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">

  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:RO_CIUS:1.0.1</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(invoice.invoice_number)}</cbc:ID>
  <cbc:IssueDate>${formatDate(invoice.invoice_date)}</cbc:IssueDate>
  ${invoice.due_date ? `<cbc:DueDate>${formatDate(invoice.due_date)}</cbc:DueDate>` : ''}
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${invoice.currency}</cbc:DocumentCurrencyCode>

  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName>
        <cbc:Name>${escapeXml(invoice.seller_name)}</cbc:Name>
      </cac:PartyName>
      ${invoice.seller_address ? `<cac:PostalAddress><cbc:StreetName>${escapeXml(invoice.seller_address)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>RO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>` : ''}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>RO${escapeXml(invoice.seller_cui)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(invoice.seller_name)}</cbc:RegistrationName>
        <cbc:CompanyID>${escapeXml(invoice.seller_cui)}</cbc:CompanyID>
      </cac:PartyLegalEntity>
      ${invoice.seller_iban ? `<cac:FinancialAccount><cbc:ID>${escapeXml(invoice.seller_iban)}</cbc:ID></cac:FinancialAccount>` : ''}
    </cac:Party>
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName>
        <cbc:Name>${escapeXml(invoice.buyer_name)}</cbc:Name>
      </cac:PartyName>
      ${invoice.buyer_address ? `<cac:PostalAddress><cbc:StreetName>${escapeXml(invoice.buyer_address)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>RO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>` : ''}
      ${invoice.buyer_cui ? `<cac:PartyTaxScheme><cbc:CompanyID>RO${escapeXml(invoice.buyer_cui)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(invoice.buyer_name)}</cbc:RegistrationName>
        ${invoice.buyer_cui ? `<cbc:CompanyID>${escapeXml(invoice.buyer_cui)}</cbc:CompanyID>` : ''}
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${invoice.currency}">${invoice.vat_total.toFixed(2)}</cbc:TaxAmount>
    ${taxSubtotals}
  </cac:TaxTotal>

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${invoice.currency}">${invoice.subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${invoice.currency}">${invoice.subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${invoice.currency}">${invoice.total.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${invoice.currency}">${invoice.total.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>

  ${invoiceLines}
</Invoice>`;
}
