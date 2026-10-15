// Top 300 global airports by passenger traffic + common regional hubs
// Used for validating community-submitted flight data
const IATA_CODES = new Set([
  // North America
  'ATL', 'DFW', 'DEN', 'ORD', 'LAX', 'JFK', 'LAS', 'MCO', 'MIA', 'CLT',
  'SEA', 'PHX', 'EWR', 'SFO', 'IAH', 'BOS', 'FLL', 'MSP', 'LGA', 'DTW',
  'PHL', 'SLC', 'DCA', 'SAN', 'IAD', 'BWI', 'TPA', 'AUS', 'BNA', 'MDW',
  'HNL', 'DAL', 'STL', 'HOU', 'OAK', 'SJC', 'SMF', 'RDU', 'SNA', 'CLE',
  'SAT', 'PIT', 'IND', 'PDX', 'CMH', 'MCI', 'MKE', 'JAX', 'OGG', 'RSW',
  'YYZ', 'YVR', 'YUL', 'YYC', 'YOW', 'YEG', 'YHZ', 'MEX', 'CUN', 'GDL',
  'SJD', 'MTY', 'PVR',
  // Europe
  'LHR', 'CDG', 'AMS', 'FRA', 'IST', 'MAD', 'BCN', 'LGW', 'MUC', 'FCO',
  'DUB', 'ZRH', 'CPH', 'OSL', 'VIE', 'LIS', 'ARN', 'MAN', 'BRU', 'HEL',
  'ATH', 'WAW', 'PRG', 'BUD', 'EDI', 'HAM', 'DUS', 'STN', 'BER', 'MXP',
  'ORY', 'NCE', 'PMI', 'AGP', 'ALC', 'TFS', 'LPA', 'OPO', 'BGY', 'NAP',
  'VCE', 'BLQ', 'GVA', 'BSL', 'KRK', 'OTP', 'SOF', 'BEG', 'ZAG', 'LJU',
  'TLL', 'RIX', 'VNO', 'KEF', 'SVO', 'DME', 'LED',
  // Asia-Pacific
  'PEK', 'PVG', 'CAN', 'HKG', 'NRT', 'HND', 'ICN', 'SIN', 'BKK', 'KUL',
  'CGK', 'DEL', 'BOM', 'MAA', 'BLR', 'CCU', 'HYD', 'TPE', 'MNL', 'SGN',
  'HAN', 'KIX', 'NGO', 'CTU', 'SZX', 'WUH', 'CKG', 'XIY', 'CSX', 'NKG',
  'SHA', 'TSA', 'DPS', 'SUB', 'RGN', 'CMB', 'KTM', 'DAD', 'CEB', 'PNH',
  // Middle East
  'DXB', 'DOH', 'AUH', 'JED', 'RUH', 'AMM', 'KWI', 'BAH', 'MCT', 'TLV',
  // Africa
  'JNB', 'CPT', 'CAI', 'ADD', 'NBO', 'LOS', 'ABV', 'CMN', 'ALG', 'TUN',
  'ACC', 'DAR', 'EBB', 'DKR', 'MPM',
  // South America
  'GRU', 'GIG', 'EZE', 'BOG', 'SCL', 'LIM', 'BSB', 'CNF', 'SSA', 'REC',
  'CWB', 'POA', 'MVD', 'UIO', 'PTY', 'CCS', 'MDE', 'CLO', 'CTG',
  // Oceania
  'SYD', 'MEL', 'BNE', 'PER', 'AKL', 'CHC', 'WLG', 'ADL', 'OOL', 'CBR',
]);

const IATA_REGEX = /^[A-Z]{3}$/;

export function isValidIATA(code: string): boolean {
  if (!IATA_REGEX.test(code)) return false;
  return IATA_CODES.has(code);
}
