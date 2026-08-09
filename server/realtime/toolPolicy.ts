export type ToolRisk = 'READ_ONLY' | 'LOW_RISK' | 'CONFIRM_REQUIRED' | 'HIGH_RISK';

const TOOL_RISK: Record<string, ToolRisk> = {
  searchWeb: 'READ_ONLY',
  fetchUrl: 'READ_ONLY',
  querySubscriberDatabase: 'READ_ONLY',
  displayWidget: 'LOW_RISK',
  requestUserInputField: 'LOW_RISK',
  checkElectricityBill: 'READ_ONLY',
  fillAndSubmitBillForm: 'CONFIRM_REQUIRED',
  submitForm: 'CONFIRM_REQUIRED',
  submitServiceRequest: 'CONFIRM_REQUIRED',
  initiateLivePhoneCall: 'CONFIRM_REQUIRED',
  reportOutage: 'CONFIRM_REQUIRED',
  loginToCustomerPortal: 'CONFIRM_REQUIRED',
  executeNodeCode: 'HIGH_RISK',
};

export function getToolRisk(toolName: string): ToolRisk {
  return TOOL_RISK[toolName] ?? 'HIGH_RISK';
}

export function isToolAllowedWithoutConfirmation(toolName: string): boolean {
  const risk = getToolRisk(toolName);
  return risk === 'READ_ONLY' || risk === 'LOW_RISK';
}
