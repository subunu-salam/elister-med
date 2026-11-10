/** Static reference data for the one-year Elister Med demo: UAE patient population, clinical vocabulary, price list, suppliers, payers. All people are fictional. */

export type Rng = () => number;
export const mulberry32 = (seed: number): Rng => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------- People ----------
export type Origin = { nat: string; weight: number; m: string[]; f: string[]; last: string[]; arabic: boolean; phonePrefix?: string };
export const ORIGINS: Origin[] = [
  { nat: "United Arab Emirates", weight: 10, arabic: true,
    m: ["Mohammed", "Ahmed", "Khalid", "Saeed", "Rashid", "Hamdan", "Sultan", "Abdulla", "Salem", "Hamad", "Zayed", "Mansoor", "Obaid", "Juma", "Majid", "Humaid"],
    f: ["Fatima", "Maryam", "Aisha", "Shamsa", "Latifa", "Noura", "Moza", "Hessa", "Salama", "Alia", "Mahra", "Shaikha", "Amna"],
    last: ["Al Mazrouei", "Al Suwaidi", "Al Falasi", "Al Ketbi", "Al Nuaimi", "Al Ali", "Al Shamsi", "Al Marri", "Al Mansoori", "Al Hammadi", "Al Muhairi", "Al Dhaheri", "Al Blooshi", "Al Zaabi", "Al Kaabi", "Al Remeithi"] },
  { nat: "India", weight: 22, arabic: false,
    m: ["Rahul", "Amit", "Vijay", "Suresh", "Arun", "Sanjay", "Rajesh", "Anil", "Deepak", "Manoj", "Prakash", "Nikhil", "Rohit", "Sunil", "Vikram", "Ravi", "Joseph", "Binu", "Shibu"],
    f: ["Priya", "Anjali", "Sneha", "Divya", "Neha", "Pooja", "Lakshmi", "Kavitha", "Swati", "Meera", "Deepa", "Sunita", "Anitha", "Reshma", "Sherin"],
    last: ["Nair", "Menon", "Kumar", "Sharma", "Patel", "Reddy", "Iyer", "Pillai", "Gupta", "Singh", "Joshi", "Verma", "Shetty", "Varghese", "Thomas", "Mathew", "George", "D'Souza", "Krishnan"] },
  { nat: "Pakistan", weight: 12, arabic: false,
    m: ["Imran", "Usman", "Bilal", "Faisal", "Hamza", "Asif", "Kamran", "Zubair", "Tariq", "Naveed", "Adnan", "Waqas", "Shahid"],
    f: ["Ayesha", "Sana", "Hina", "Farah", "Saima", "Nadia", "Bushra", "Rabia", "Mehwish", "Zainab", "Samina"],
    last: ["Khan", "Ahmed", "Malik", "Hussain", "Qureshi", "Siddiqui", "Sheikh", "Butt", "Chaudhry", "Ansari", "Raza", "Iqbal", "Mirza"] },
  { nat: "Philippines", weight: 8, arabic: false,
    m: ["Mark", "John", "Jericho", "Ramon", "Carlo", "Joel", "Arnel", "Rommel", "Jose"],
    f: ["Maria", "Angelica", "Jasmine", "Cristina", "Rose", "Grace", "Jocelyn", "Marites", "Karen", "Liza"],
    last: ["Santos", "Reyes", "Cruz", "Bautista", "Garcia", "Mendoza", "Dela Cruz", "Ramos", "Aquino", "Villanueva", "Navarro"] },
  { nat: "Egypt", weight: 7, arabic: true,
    m: ["Mahmoud", "Mostafa", "Karim", "Hossam", "Tamer", "Amr", "Wael", "Sherif"],
    f: ["Mona", "Heba", "Nour", "Dina", "Rania", "Salma", "Yasmin", "Noha"],
    last: ["Hassan", "Ibrahim", "Abdelrahman", "Mohamed", "Farouk", "Soliman", "El Sayed", "Mansour", "Fahmy", "Gamal"] },
  { nat: "Bangladesh", weight: 6, arabic: false,
    m: ["Rahim", "Karim", "Shakib", "Tanvir", "Mizanur", "Jahid", "Hasan", "Nasir"],
    f: ["Fatema", "Nusrat", "Sharmin", "Rokeya", "Tasnim", "Shirin"],
    last: ["Rahman", "Hossain", "Islam", "Uddin", "Chowdhury", "Miah", "Akter", "Sarker"] },
  { nat: "Jordan", weight: 3, arabic: true, m: ["Omar", "Yousef", "Khaled", "Hani", "Majed", "Tareq"], f: ["Layla", "Hana", "Rima", "Dalia", "Lina", "Reem"], last: ["Haddad", "Nasser", "Khoury", "Saleh", "Darwish", "Abu Samra", "Al Tarawneh"] },
  { nat: "Syria", weight: 3, arabic: true, m: ["Samer", "Fadi", "Ammar", "Bashar", "Tarek", "Hussam"], f: ["Rana", "Nada", "Lama", "Hiba", "Ghada", "Maha"], last: ["Al Masri", "Kassab", "Haddad", "Sabbagh", "Hamdan", "Aleppo"] },
  { nat: "Lebanon", weight: 3, arabic: true, m: ["Elie", "Charbel", "Georges", "Nabil", "Ziad", "Rami"], f: ["Carla", "Nour", "Maya", "Joelle", "Rita", "Hana"], last: ["Kobeissi", "Khoury", "Haddad", "Gemayel", "Saade", "Fakhoury"] },
  { nat: "Sudan", weight: 3, arabic: true, m: ["Osman", "Babiker", "Mazin", "Hatim", "Ayman"], f: ["Amira", "Sara", "Eman", "Hiba", "Nahla"], last: ["Osman", "Babiker", "Elhaj", "Abdelgadir", "Mahgoub"] },
  { nat: "Nepal", weight: 2, arabic: false, m: ["Ram Bahadur", "Binod", "Suresh", "Prakash", "Dipesh"], f: ["Sita", "Sunita", "Anita", "Binita", "Kamala"], last: ["Thapa", "Gurung", "Sharma", "Rai", "Shrestha", "Tamang"] },
  { nat: "Sri Lanka", weight: 2, arabic: false, m: ["Nimal", "Kasun", "Chaminda", "Ruwan"], f: ["Dilani", "Nirmala", "Sanduni", "Kumari"], last: ["Perera", "Fernando", "Silva", "Jayasinghe", "De Silva"] },
  { nat: "United Kingdom", weight: 4, arabic: false, m: ["James", "Oliver", "Daniel", "Thomas", "Harry", "George"], f: ["Emma", "Sophie", "Charlotte", "Amelia", "Olivia"], last: ["Wilson", "Clarke", "Smith", "Brown", "Murphy", "Walker", "Hughes"] },
  { nat: "Russia", weight: 3, arabic: false, m: ["Alexander", "Dmitry", "Sergey", "Andrei"], f: ["Natalia", "Elena", "Olga", "Anastasia", "Irina"], last: ["Petrov", "Ivanov", "Sokolov", "Volkova", "Smirnov"] },
  { nat: "Iran", weight: 2, arabic: false, m: ["Reza", "Ali", "Hossein", "Mehdi"], f: ["Leila", "Mina", "Shirin", "Parisa"], last: ["Rezaei", "Hosseini", "Karimi", "Ahmadi"] },
];

export const AREAS = [
  "Al Qusais 1", "Al Qusais 2", "Al Qusais Industrial Area 3", "Al Nahda 1, Dubai", "Al Nahda 2, Dubai", "Al Twar 1", "Muhaisnah 2", "Al Mizhar 1", "Mirdif",
  "Al Warqa 1", "Dubai Silicon Oasis", "International City", "Deira, Dubai", "Bur Dubai", "Al Barsha 1", "Jumeirah Village Circle", "Business Bay", "Sharjah, Al Nahda", "Sharjah, Al Taawun",
];
export const REFERRALS: [string, number][] = [["google", 26], ["walk-in", 18], ["referral", 20], ["instagram", 12], ["insurance network", 9], ["facebook", 5], ["tiktok", 3], ["website", 4], ["whatsapp", 3]];
export const ALLERGIES = [
  { substance: "Penicillin", reaction: "Rash", severity: "moderate" as const }, { substance: "Ibuprofen", reaction: "Urticaria", severity: "moderate" as const },
  { substance: "Sulfonamides", reaction: "Rash", severity: "mild" as const }, { substance: "Latex", reaction: "Contact dermatitis", severity: "mild" as const },
  { substance: "Aspirin", reaction: "Wheeze", severity: "severe" as const }, { substance: "Amoxicillin", reaction: "Rash", severity: "moderate" as const },
];

// ---------- Departments / doctors ----------
export const NEW_DOCTORS = [
  { userKey: "dr.imran", name: "Dr. Imran Qureshi", nameAr: "د. عمران قريشي", dept: "PED", specialty: "Paediatrics", licence: "DHA-PRAC-4471182", days: [1, 2, 3, 4, 5, 6] },
  { userKey: "dr.nadia", name: "Dr. Nadia Farouk", nameAr: "د. نادية فاروق", dept: "OBGYN", specialty: "Obstetrics & Gynaecology", licence: "DHA-PRAC-3390267", days: [1, 2, 3, 4, 5, 6] },
];
export const DOCTOR_LICENCES: Record<string, string> = { "dr.amina": "DHA-PRAC-3812045", "dr.omar": "DHA-PRAC-2970318", "dr.layla": "DHA-PRAC-4120953" };

// ---------- Price list ----------
// tax: "ZERO" = qualifying healthcare (zero-rated under UAE VAT), "STD" = cosmetic/aesthetic (standard 5%). Every service keeps reviewRequired = true.
export type Svc = { code: string; name: string; dept: string; kind: string; price: string; rev: string; tax: "ZERO" | "STD"; consultation?: boolean };
export const NEW_SERVICES: Svc[] = [
  { code: "SVC-ECG", name: "ECG (12-lead)", dept: "GP", kind: "procedure", price: "120.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "SVC-NEB", name: "Nebulisation", dept: "GP", kind: "procedure", price: "90.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "SVC-INJ", name: "Injection (IM/IV) administration", dept: "GP", kind: "procedure", price: "60.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "SVC-IVD", name: "IV drip (hydration/vitamin)", dept: "GP", kind: "procedure", price: "350.00", rev: "rev_procedure", tax: "STD" },
  { code: "SVC-SUT", name: "Minor suturing", dept: "GP", kind: "procedure", price: "450.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "SVC-FIT", name: "Medical fitness examination", dept: "GP", kind: "consultation", price: "300.00", rev: "rev_consultation", tax: "ZERO" },
  { code: "VAC-FLU", name: "Influenza vaccine", dept: "GP", kind: "procedure", price: "130.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "VAC-MMR", name: "MMR vaccine", dept: "PED", kind: "procedure", price: "150.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "VAC-HEXA", name: "Hexavalent vaccine", dept: "PED", kind: "procedure", price: "320.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "VAC-HEPB", name: "Hepatitis B vaccine", dept: "PED", kind: "procedure", price: "90.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "LAB-GLU", name: "Glucose (fasting)", dept: "LAB", kind: "lab", price: "40.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-HBA1C", name: "HbA1c", dept: "LAB", kind: "lab", price: "110.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-CHOL", name: "Total cholesterol", dept: "LAB", kind: "lab", price: "55.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-TG", name: "Triglycerides", dept: "LAB", kind: "lab", price: "55.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-VITD", name: "Vitamin D (25-OH)", dept: "LAB", kind: "lab", price: "180.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-TSH", name: "Thyroid stimulating hormone", dept: "LAB", kind: "lab", price: "120.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-CREAT", name: "Creatinine", dept: "LAB", kind: "lab", price: "50.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-ALT", name: "ALT (SGPT)", dept: "LAB", kind: "lab", price: "50.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-CRP", name: "C-reactive protein", dept: "LAB", kind: "lab", price: "70.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "LAB-FERR", name: "Ferritin", dept: "LAB", kind: "lab", price: "130.00", rev: "rev_laboratory", tax: "ZERO" },
  { code: "RAD-XR-CHEST", name: "X-ray chest PA", dept: "GP", kind: "radiology", price: "150.00", rev: "rev_radiology", tax: "ZERO" },
  { code: "RAD-XR-LIMB", name: "X-ray limb (single view)", dept: "GP", kind: "radiology", price: "130.00", rev: "rev_radiology", tax: "ZERO" },
  { code: "RAD-US-ABD", name: "Ultrasound abdomen", dept: "GP", kind: "radiology", price: "300.00", rev: "rev_radiology", tax: "ZERO" },
  { code: "RAD-US-OB", name: "Ultrasound obstetric", dept: "OBGYN", kind: "radiology", price: "280.00", rev: "rev_radiology", tax: "ZERO" },
  { code: "OB-PAP", name: "Pap smear collection", dept: "OBGYN", kind: "procedure", price: "250.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "DENT-XRAY", name: "Dental X-ray (periapical)", dept: "DENT", kind: "radiology", price: "60.00", rev: "rev_dental", tax: "ZERO" },
  { code: "DENT-FILL", name: "Composite filling", dept: "DENT", kind: "procedure", price: "350.00", rev: "rev_dental", tax: "ZERO" },
  { code: "DENT-EXT", name: "Simple extraction", dept: "DENT", kind: "procedure", price: "300.00", rev: "rev_dental", tax: "ZERO" },
  { code: "DENT-SURGEXT", name: "Surgical extraction", dept: "DENT", kind: "procedure", price: "650.00", rev: "rev_dental", tax: "ZERO" },
  { code: "DENT-RCT", name: "Root canal treatment", dept: "DENT", kind: "procedure", price: "1200.00", rev: "rev_dental", tax: "ZERO" },
  { code: "DENT-CROWN", name: "Zirconia crown", dept: "DENT", kind: "procedure", price: "1500.00", rev: "rev_dental", tax: "ZERO" },
  { code: "DENT-WHITE", name: "Teeth whitening", dept: "DENT", kind: "procedure", price: "900.00", rev: "rev_dental", tax: "STD" },
  { code: "DERM-WART", name: "Cryotherapy (warts / lesions)", dept: "DERM", kind: "procedure", price: "300.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "DERM-BIOPSY", name: "Skin biopsy", dept: "DERM", kind: "procedure", price: "550.00", rev: "rev_procedure", tax: "ZERO" },
  { code: "AES-BOTOX", name: "Botulinum toxin (per area)", dept: "AESTH", kind: "procedure", price: "1200.00", rev: "rev_aesthetic", tax: "STD" },
  { code: "AES-FILLER", name: "Dermal filler (per syringe)", dept: "AESTH", kind: "procedure", price: "1800.00", rev: "rev_aesthetic", tax: "STD" },
  { code: "AES-PEEL", name: "Chemical peel", dept: "AESTH", kind: "procedure", price: "450.00", rev: "rev_aesthetic", tax: "STD" },
  { code: "AES-HYDRA", name: "Hydrafacial", dept: "AESTH", kind: "procedure", price: "650.00", rev: "rev_aesthetic", tax: "STD" },
  { code: "AES-LASER", name: "Laser hair removal (small area)", dept: "AESTH", kind: "procedure", price: "350.00", rev: "rev_aesthetic", tax: "STD" },
  { code: "AES-MESO", name: "Mesotherapy session", dept: "AESTH", kind: "procedure", price: "700.00", rev: "rev_aesthetic", tax: "STD" },
];
/** Existing seed services (src/modules/org/seed.ts): their VAT treatment is aligned with the rule above. */
export const EXISTING_SERVICE_TAX: Record<string, "ZERO" | "STD"> = {
  "CONS-GP": "ZERO", "CONS-DENT": "ZERO", "CONS-DERM": "ZERO", "CONS-FU": "ZERO", "PROC-SCALE": "ZERO", "PROC-DRESS": "ZERO", "LAB-CBC": "ZERO",
  "CONS-PED": "ZERO", "CONS-OBGYN": "ZERO", "CONS-AESTH": "STD",
};

// ---------- Laboratory (illustrative ranges, approved by the medical director in the seed) ----------
export type LabDef = { code: string; name: string; loinc: string; specimen: string; unit: string; serviceCode: string; ranges: { sex?: "male" | "female"; low: number; high: number; criticalLow?: number; criticalHigh?: number }[]; mean: [number, number]; sd: number };
export const LAB_TESTS: LabDef[] = [
  { code: "HGB", name: "Haemoglobin", loinc: "718-7", specimen: "Whole blood", unit: "g/dL", serviceCode: "LAB-CBC", ranges: [{ sex: "male", low: 13, high: 17, criticalLow: 7, criticalHigh: 20 }, { sex: "female", low: 12, high: 15.5, criticalLow: 7, criticalHigh: 20 }], mean: [14.8, 13.3], sd: 1.5 },
  { code: "GLU", name: "Glucose (fasting)", loinc: "1558-6", specimen: "Serum", unit: "mmol/L", serviceCode: "LAB-GLU", ranges: [{ low: 3.9, high: 5.6, criticalLow: 2.5, criticalHigh: 25 }], mean: [5.6, 5.6], sd: 1.3 },
  { code: "HBA1C", name: "HbA1c", loinc: "4548-4", specimen: "Whole blood", unit: "%", serviceCode: "LAB-HBA1C", ranges: [{ low: 4, high: 5.6, criticalHigh: 14 }], mean: [5.9, 5.9], sd: 1.1 },
  { code: "CHOL", name: "Total cholesterol", loinc: "2093-3", specimen: "Serum", unit: "mmol/L", serviceCode: "LAB-CHOL", ranges: [{ low: 2, high: 5.2 }], mean: [5.1, 5.0], sd: 1.0 },
  { code: "TG", name: "Triglycerides", loinc: "2571-8", specimen: "Serum", unit: "mmol/L", serviceCode: "LAB-TG", ranges: [{ low: 0.3, high: 1.7 }], mean: [1.8, 1.4], sd: 0.8 },
  { code: "VITD", name: "Vitamin D (25-OH)", loinc: "1989-3", specimen: "Serum", unit: "ng/mL", serviceCode: "LAB-VITD", ranges: [{ low: 30, high: 100, criticalLow: 4 }], mean: [22, 19], sd: 10 },
  { code: "TSH", name: "Thyroid stimulating hormone", loinc: "3016-3", specimen: "Serum", unit: "mIU/L", serviceCode: "LAB-TSH", ranges: [{ low: 0.4, high: 4.0 }], mean: [2.4, 2.9], sd: 1.6 },
  { code: "CREAT", name: "Creatinine", loinc: "2160-0", specimen: "Serum", unit: "µmol/L", serviceCode: "LAB-CREAT", ranges: [{ sex: "male", low: 62, high: 106, criticalHigh: 500 }, { sex: "female", low: 44, high: 80, criticalHigh: 500 }], mean: [88, 66], sd: 12 },
  { code: "ALT", name: "ALT (SGPT)", loinc: "1742-6", specimen: "Serum", unit: "U/L", serviceCode: "LAB-ALT", ranges: [{ sex: "male", low: 7, high: 50 }, { sex: "female", low: 7, high: 35 }], mean: [38, 27], sd: 14 },
  { code: "CRP", name: "C-reactive protein", loinc: "1988-5", specimen: "Serum", unit: "mg/L", serviceCode: "LAB-CRP", ranges: [{ low: 0, high: 5 }], mean: [6, 6], sd: 7 },
  { code: "FERR", name: "Ferritin", loinc: "2276-4", specimen: "Serum", unit: "ng/mL", serviceCode: "LAB-FERR", ranges: [{ sex: "male", low: 30, high: 400 }, { sex: "female", low: 13, high: 150 }], mean: [140, 55], sd: 60 },
];

// ---------- Diagnoses, with ICD-10-CM codes ----------
export type Dx = { code: string; description: string; s: string; o: string; a: string; p: string; w: number; labs?: string[]; rx?: string[]; extra?: string[]; rad?: string; sick?: boolean };
export const DX: Record<string, Dx[]> = {
  GP: [
    { code: "J06.9", description: "Acute upper respiratory infection, unspecified", s: "Sore throat, nasal congestion and cough for 3 days. No breathlessness.", o: "Afebrile, throat mildly erythematous, chest clear.", a: "Viral upper respiratory tract infection.", p: "Symptomatic treatment, fluids, rest. Review if fever persists beyond 3 days.", w: 16, rx: ["PARA-500", "CETI-10"], extra: ["VAC-FLU:0.05"] },
    { code: "J02.9", description: "Acute pharyngitis, unspecified", s: "Painful swallowing and fever since yesterday.", o: "Temp 38.1 C, tonsils inflamed, no exudate.", a: "Acute pharyngitis.", p: "Analgesia and throat care; antibiotics only if bacterial features develop.", w: 7, rx: ["PARA-500", "IBU-400"], labs: ["CRP:0.2"] },
    { code: "J20.9", description: "Acute bronchitis, unspecified", s: "Productive cough for 5 days with mild wheeze.", o: "SpO2 98%, scattered rhonchi, no consolidation.", a: "Acute bronchitis.", p: "Bronchodilator, fluids, review in one week if not improving.", w: 5, rx: ["SALB-INH", "PARA-500"], extra: ["SVC-NEB:0.4"], rad: "RAD-XR-CHEST:0.12" },
    { code: "A09", description: "Infectious gastroenteritis and colitis, unspecified", s: "Loose stools and vomiting since last night.", o: "Mild dehydration, abdomen soft, mild generalised tenderness.", a: "Acute gastroenteritis.", p: "Oral rehydration, diet advice, return if blood in stool or persistent vomiting.", w: 5, rx: ["ORS-SACH", "OMEP-20"], extra: ["SVC-IVD:0.12"] },
    { code: "K29.70", description: "Gastritis, unspecified, without bleeding", s: "Epigastric burning for two weeks, worse after spicy meals.", o: "Mild epigastric tenderness.", a: "Gastritis.", p: "PPI course, avoid NSAIDs, dietary advice.", w: 4, rx: ["OMEP-20"] },
    { code: "N39.0", description: "Urinary tract infection, site not specified", s: "Burning micturition and frequency for 2 days.", o: "Suprapubic tenderness, afebrile.", a: "Uncomplicated lower urinary tract infection.", p: "Antibiotic course, increase fluids, urine culture if recurrent.", w: 3, rx: ["CIPR-500", "PARA-500"] },
    { code: "M54.50", description: "Low back pain, unspecified", s: "Lower back pain after lifting, no radiation or weakness.", o: "Paraspinal tenderness, SLR negative, neurology intact.", a: "Mechanical low back pain.", p: "Analgesia, topical NSAID, posture advice, physiotherapy if persistent.", w: 5, rx: ["DICLO-GEL", "IBU-400"], rad: "RAD-XR-LIMB:0.1" },
    { code: "R51.9", description: "Headache, unspecified", s: "Recurrent frontal headaches, worse with screen time.", o: "Neurological examination normal, BP normal.", a: "Tension-type headache.", p: "Analgesia, hydration, sleep hygiene, review if red flags.", w: 4, rx: ["PARA-500"] },
    { code: "I10", description: "Essential (primary) hypertension", s: "Routine review of hypertension, no chest pain or palpitations.", o: "BP above target, heart sounds normal.", a: "Essential hypertension, partially controlled.", p: "Continue/adjust antihypertensive, low salt diet, repeat BP in 2 weeks.", w: 6, rx: ["AMLO-5"], labs: ["CREAT:0.5", "CHOL:0.5"], extra: ["SVC-ECG:0.3"] },
    { code: "E11.9", description: "Type 2 diabetes mellitus without complications", s: "Diabetes follow-up, adherent to medication.", o: "BMI elevated, foot examination normal.", a: "Type 2 diabetes mellitus.", p: "Continue metformin, HbA1c in 3 months, dietitian referral.", w: 6, rx: ["METF-500"], labs: ["HBA1C:0.9", "GLU:0.5", "CREAT:0.4"] },
    { code: "E78.5", description: "Hyperlipidaemia, unspecified", s: "Follow-up for raised cholesterol.", o: "No xanthomata, BP normal.", a: "Hyperlipidaemia.", p: "Statin therapy and lifestyle changes, repeat lipids in 3 months.", w: 3, rx: ["ATOR-20"], labs: ["CHOL:0.9", "TG:0.9", "ALT:0.4"] },
    { code: "E55.9", description: "Vitamin D deficiency, unspecified", s: "Fatigue and body aches.", o: "General examination unremarkable.", a: "Suspected vitamin D deficiency.", p: "Check level and supplement as indicated.", w: 6, rx: ["VITD-50K"], labs: ["VITD:0.95", "HGB:0.5"] },
    { code: "D50.9", description: "Iron deficiency anaemia, unspecified", s: "Tiredness, pallor and hair shedding.", o: "Pale conjunctivae, tachycardia mild.", a: "Probable iron deficiency anaemia.", p: "Blood tests and iron replacement, dietary advice.", w: 3, rx: ["FA-5"], labs: ["HGB:1", "FERR:0.9"] },
    { code: "J30.9", description: "Allergic rhinitis, unspecified", s: "Sneezing, itchy eyes and watery nasal discharge, dust-triggered.", o: "Pale nasal mucosa, clear chest.", a: "Allergic rhinitis.", p: "Antihistamine, allergen avoidance, saline rinse.", w: 5, rx: ["CETI-10", "LORA-10"] },
    { code: "K21.9", description: "Gastro-oesophageal reflux disease without oesophagitis", s: "Heartburn and acid regurgitation, worse at night.", o: "Mild epigastric discomfort.", a: "GERD.", p: "PPI, avoid late meals, raise head of bed.", w: 3, rx: ["OMEP-20"] },
    { code: "Z00.00", description: "Encounter for general adult medical examination", s: "Requests routine health check.", o: "Examination normal, BMI recorded.", a: "Healthy adult, screening bloods requested.", p: "Screening profile and lifestyle counselling.", w: 6, labs: ["HGB:1", "GLU:1", "CHOL:0.9", "TG:0.9", "VITD:0.7", "TSH:0.5"] },
    { code: "Z02.89", description: "Encounter for other administrative examinations (medical fitness)", s: "Requires medical fitness certificate for visa/employment.", o: "Fit on examination, chest clear, vision and BP normal.", a: "Medically fit.", p: "Certificate issued.", w: 3, extra: ["SVC-FIT:1"], rad: "RAD-XR-CHEST:0.5" },
    { code: "R50.9", description: "Fever, unspecified", s: "Fever and body aches for 2 days.", o: "Temp 38.4 C, no focus on examination.", a: "Viral febrile illness.", p: "Antipyretics, fluids, return if fever persists beyond 72 hours.", w: 5, rx: ["PARA-500"], labs: ["CRP:0.5", "HGB:0.3"] },
    { code: "S01.80XA", description: "Unspecified open wound, initial encounter", s: "Cut to the hand while cooking.", o: "2 cm clean laceration, neurovascularly intact.", a: "Minor laceration.", p: "Wound cleaning and closure, tetanus status checked.", w: 2, extra: ["SVC-SUT:0.5", "PROC-DRESS:1"], rx: ["AMOX-500"] },
  ],
  DENT: [
    { code: "K02.9", description: "Dental caries, unspecified", s: "Sensitivity to cold in lower right molar.", o: "Occlusal caries on tooth 46, vitality positive.", a: "Dental caries.", p: "Composite restoration placed under local anaesthesia.", w: 22, extra: ["DENT-XRAY:0.9", "DENT-FILL:1"] },
    { code: "K05.10", description: "Chronic gingivitis, plaque induced", s: "Bleeding gums on brushing.", o: "Generalised plaque and marginal gingivitis.", a: "Chronic gingivitis.", p: "Scaling and polish, oral hygiene instruction, review in 6 months.", w: 20, extra: ["PROC-SCALE:1"], rx: ["CHX-MW"] },
    { code: "K04.0", description: "Pulpitis", s: "Severe throbbing toothache, worse at night.", o: "Deep caries on tooth 36, tender to percussion.", a: "Irreversible pulpitis.", p: "Root canal treatment started; analgesia prescribed.", w: 9, extra: ["DENT-XRAY:1", "DENT-RCT:0.9"], rx: ["IBU-400", "AMOX-500"] },
    { code: "K08.1", description: "Complete loss of teeth due to trauma, extraction or periodontal disease", s: "Non-restorable tooth with pain.", o: "Tooth 18 severely broken down.", a: "Non-restorable tooth.", p: "Extraction under local anaesthesia, post-operative instructions given.", w: 10, extra: ["DENT-XRAY:1", "DENT-EXT:0.75", "DENT-SURGEXT:0.25"], rx: ["IBU-400"] },
    { code: "K03.6", description: "Deposits [accretions] on teeth", s: "Wants teeth cleaned, stained teeth.", o: "Calculus and extrinsic staining.", a: "Dental calculus and staining.", p: "Scaling and polishing; whitening discussed.", w: 14, extra: ["PROC-SCALE:1", "DENT-WHITE:0.18"] },
    { code: "K00.6", description: "Disturbances in tooth eruption", s: "Pain at the back of the lower jaw.", o: "Partially erupted impacted wisdom tooth with pericoronitis.", a: "Pericoronitis.", p: "Irrigation, antibiotics, extraction planned.", w: 5, extra: ["DENT-XRAY:1"], rx: ["AMOX-500", "IBU-400"] },
    { code: "Z01.20", description: "Encounter for dental examination and cleaning without abnormal findings", s: "Routine dental check-up.", o: "Good oral hygiene, no new caries.", a: "Healthy dentition.", p: "Routine review in 6 months.", w: 12, extra: ["DENT-XRAY:0.4"] },
    { code: "K02.52", description: "Dental caries on pit and fissure surface penetrating into dentin", s: "Food impaction between teeth.", o: "Interproximal caries.", a: "Dental caries with crown-needing breakdown.", p: "Crown preparation and temporary crown.", w: 8, extra: ["DENT-XRAY:1", "DENT-CROWN:0.55", "DENT-FILL:0.45"] },
  ],
  DERM: [
    { code: "L70.0", description: "Acne vulgaris", s: "Facial acne for several months, worse before menses.", o: "Inflammatory papules and comedones on the face.", a: "Moderate acne vulgaris.", p: "Topical retinoid and antibiotic gel, sun protection, review in 6 weeks.", w: 16, rx: ["TRET-CR", "CLIN-GEL"], extra: ["AES-PEEL:0.12"] },
    { code: "L20.9", description: "Atopic dermatitis, unspecified", s: "Itchy dry patches on flexures.", o: "Eczematous plaques with excoriation.", a: "Atopic dermatitis flare.", p: "Emollients, topical steroid short course.", w: 11, rx: ["HC-1"] },
    { code: "L30.9", description: "Dermatitis, unspecified", s: "Itchy red rash on the hands.", o: "Erythematous scaly rash on both hands.", a: "Contact dermatitis.", p: "Avoid irritants, topical steroid, emollient.", w: 8, rx: ["HC-1", "CETI-10"] },
    { code: "B35.3", description: "Tinea pedis", s: "Itchy peeling between toes.", o: "Interdigital maceration and scaling.", a: "Tinea pedis.", p: "Topical antifungal for 4 weeks.", w: 6, rx: ["CLOT-CR"] },
    { code: "L65.9", description: "Nonscarring hair loss, unspecified", s: "Increased hair shedding for 3 months.", o: "Diffuse thinning, positive pull test.", a: "Telogen effluvium.", p: "Investigations, supplements, reassurance.", w: 9, labs: ["FERR:0.8", "TSH:0.7", "VITD:0.6"], rx: ["VITD-50K"] },
    { code: "L81.9", description: "Disorder of pigmentation, unspecified", s: "Dark patches on cheeks.", o: "Symmetric facial hyperpigmentation.", a: "Melasma.", p: "Sunscreen, depigmenting cream, peel course discussed.", w: 7, rx: ["TRET-CR"], extra: ["AES-PEEL:0.4"] },
    { code: "B07.9", description: "Viral wart, unspecified", s: "Wart on the finger.", o: "2 mm verrucous papule.", a: "Viral wart.", p: "Cryotherapy performed, repeat in 3 weeks if needed.", w: 4, extra: ["DERM-WART:1"] },
    { code: "L40.9", description: "Psoriasis, unspecified", s: "Scaly plaques on elbows.", o: "Well-demarcated silvery plaques.", a: "Plaque psoriasis.", p: "Topical therapy and emollients, dermatology review.", w: 3, rx: ["HC-1"], extra: ["DERM-BIOPSY:0.15"] },
    { code: "Z41.1", description: "Encounter for cosmetic surgery / aesthetic procedure", s: "Requests anti-wrinkle treatment.", o: "Dynamic forehead and glabellar lines.", a: "Facial ageing, suitable for neuromodulator.", p: "Treatment performed after consent, aftercare advice given.", w: 12, extra: ["AES-BOTOX:0.55", "AES-FILLER:0.25", "AES-HYDRA:0.3", "AES-MESO:0.12"] },
    { code: "L90.5", description: "Scar conditions and fibrosis of skin", s: "Acne scars, wants improvement.", o: "Atrophic scars on both cheeks.", a: "Post-acne scarring.", p: "Peel/mesotherapy course planned.", w: 6, extra: ["AES-PEEL:0.7", "AES-MESO:0.4", "AES-LASER:0.2"] },
  ],
  PED: [
    { code: "J06.9", description: "Acute upper respiratory infection, unspecified", s: "Runny nose and cough for 3 days, feeding well.", o: "Afebrile, ears and throat normal, chest clear.", a: "Viral URTI.", p: "Supportive care, saline drops, review if fever or breathing difficulty.", w: 22, rx: ["PARA-SYR", "CETI-SYR"] },
    { code: "H66.90", description: "Otitis media, unspecified", s: "Ear pulling and fever overnight.", o: "Bulging erythematous tympanic membrane.", a: "Acute otitis media.", p: "Antibiotic course and analgesia, review in 48 hours.", w: 8, rx: ["AMOX-SYR", "PARA-SYR"] },
    { code: "J03.90", description: "Acute tonsillitis, unspecified", s: "Sore throat and fever.", o: "Enlarged inflamed tonsils.", a: "Acute tonsillitis.", p: "Antipyretic, antibiotics if bacterial, fluids.", w: 8, rx: ["PARA-SYR", "IBU-SYR"], labs: ["CRP:0.2"] },
    { code: "A08.4", description: "Viral intestinal infection, unspecified", s: "Diarrhoea and vomiting for one day.", o: "Mild dehydration, soft abdomen.", a: "Viral gastroenteritis.", p: "Oral rehydration, continue feeds, review if worsening.", w: 7, rx: ["ORS-SACH"] },
    { code: "Z00.129", description: "Encounter for routine child health examination without abnormal findings", s: "Routine growth and development check.", o: "Growth along centiles, development appropriate.", a: "Healthy child.", p: "Vaccination schedule reviewed, nutrition advice.", w: 16, extra: ["VAC-MMR:0.2", "VAC-HEXA:0.3", "VAC-HEPB:0.15"] },
    { code: "Z23", description: "Encounter for immunization", s: "Due for scheduled vaccination.", o: "Well, afebrile.", a: "Immunisation due.", p: "Vaccine administered, aftercare advice given.", w: 12, extra: ["VAC-HEXA:0.4", "VAC-MMR:0.3", "VAC-HEPB:0.2", "VAC-FLU:0.25"] },
    { code: "J45.909", description: "Unspecified asthma, uncomplicated", s: "Night cough and wheeze after exercise.", o: "Mild expiratory wheeze, SpO2 97%.", a: "Mild persistent asthma.", p: "Reliever and preventer, trigger avoidance.", w: 6, rx: ["SALB-INH", "MONT-4"], extra: ["SVC-NEB:0.5"] },
    { code: "L22", description: "Diaper dermatitis", s: "Nappy rash for 4 days.", o: "Erythema in nappy area.", a: "Nappy dermatitis.", p: "Barrier cream, frequent changes.", w: 4, rx: ["HC-1"] },
    { code: "R05.9", description: "Cough, unspecified", s: "Dry cough at night for a week.", o: "Chest clear.", a: "Post-viral cough.", p: "Reassurance, honey, humidification.", w: 7 },
    { code: "E55.9", description: "Vitamin D deficiency, unspecified", s: "Poor appetite and leg aches.", o: "Normal examination.", a: "Suspected vitamin D deficiency.", p: "Vitamin D level and supplements.", w: 4, labs: ["VITD:0.9", "HGB:0.6"], rx: ["VITD-50K"] },
  ],
  OBGYN: [
    { code: "Z34.00", description: "Encounter for supervision of normal first pregnancy, unspecified trimester", s: "Antenatal visit, feels fetal movements.", o: "BP normal, fundal height appropriate.", a: "Uncomplicated pregnancy.", p: "Continue prenatal vitamins, routine scan and bloods.", w: 24, extra: ["RAD-US-OB:0.5"], rx: ["FA-5"], labs: ["HGB:0.6", "GLU:0.4"] },
    { code: "N92.6", description: "Irregular menstruation, unspecified", s: "Irregular cycles for several months.", o: "Abdomen soft, no mass.", a: "Irregular menstrual cycles, ?PCOS.", p: "Hormonal profile and pelvic ultrasound.", w: 12, labs: ["TSH:0.8", "HGB:0.6"], extra: ["RAD-US-OB:0.5"] },
    { code: "N76.0", description: "Acute vaginitis", s: "Vaginal discharge and itching.", o: "Erythema with curdy discharge.", a: "Vaginal candidiasis.", p: "Antifungal treatment, hygiene advice.", w: 9, rx: ["CLOT-CR"] },
    { code: "Z01.419", description: "Encounter for gynecological examination (general) without abnormal findings", s: "Annual gynaecological check.", o: "Normal examination.", a: "Healthy.", p: "Pap smear taken, routine follow-up.", w: 14, extra: ["OB-PAP:0.85"] },
    { code: "N94.6", description: "Dysmenorrhoea, unspecified", s: "Painful periods affecting daily activity.", o: "Mild lower abdominal tenderness.", a: "Primary dysmenorrhoea.", p: "NSAIDs and heat; review if no improvement.", w: 9, rx: ["MEFA-500"], extra: ["RAD-US-OB:0.3"] },
    { code: "N39.0", description: "Urinary tract infection, site not specified", s: "Burning micturition.", o: "Suprapubic tenderness.", a: "Lower UTI.", p: "Antibiotic course and fluids.", w: 7, rx: ["CIPR-500"] },
    { code: "Z30.09", description: "Encounter for other general counselling and advice on contraception", s: "Contraception counselling.", o: "BP normal.", a: "Contraception advice.", p: "Options discussed and chosen method started.", w: 6 },
  ],
};
export const DEPT_WEIGHT: [string, number][] = [["GP", 38], ["DENT", 20], ["DERM", 15], ["PED", 15], ["OBGYN", 12]];
export const DEPT_PRICE_GROUP: Record<string, string> = { GP: "GP", DENT: "DENT", DERM: "DERM", PED: "PED", OBGYN: "OBGYN" };

// ---------- Pharmacy / consumable catalogue ----------
export type ItemDef = { sku: string; name: string; generic?: string; category: "medicine" | "consumable"; strength?: string; form?: string; cost: number; price?: number; level: number; qty: number; vat: boolean; supplier: "MED" | "DEN" | "GEN" };
export const ITEMS: ItemDef[] = [
  { sku: "PARA-500", name: "Paracetamol 500mg tablets", generic: "paracetamol", category: "medicine", strength: "500 mg", form: "tablet", cost: 0.18, price: 0.6, level: 600, qty: 2400, vat: false, supplier: "MED" },
  { sku: "IBU-400", name: "Ibuprofen 400mg tablets", generic: "ibuprofen", category: "medicine", strength: "400 mg", form: "tablet", cost: 0.3, price: 1.0, level: 300, qty: 1200, vat: false, supplier: "MED" },
  { sku: "AMOX-500", name: "Amoxicillin 500mg capsules", generic: "amoxicillin", category: "medicine", strength: "500 mg", form: "capsule", cost: 0.55, price: 1.8, level: 300, qty: 1200, vat: false, supplier: "MED" },
  { sku: "AUG-1G", name: "Amoxicillin/Clavulanate 1g tablets", generic: "amoxicillin clavulanate", category: "medicine", strength: "1 g", form: "tablet", cost: 3.2, price: 7.5, level: 100, qty: 400, vat: false, supplier: "MED" },
  { sku: "AZI-500", name: "Azithromycin 500mg tablets", generic: "azithromycin", category: "medicine", strength: "500 mg", form: "tablet", cost: 4.5, price: 11.0, level: 60, qty: 240, vat: false, supplier: "MED" },
  { sku: "CIPR-500", name: "Ciprofloxacin 500mg tablets", generic: "ciprofloxacin", category: "medicine", strength: "500 mg", form: "tablet", cost: 0.9, price: 2.8, level: 100, qty: 400, vat: false, supplier: "MED" },
  { sku: "CETI-10", name: "Cetirizine 10mg tablets", generic: "cetirizine", category: "medicine", strength: "10 mg", form: "tablet", cost: 0.2, price: 0.7, level: 300, qty: 1200, vat: false, supplier: "MED" },
  { sku: "LORA-10", name: "Loratadine 10mg tablets", generic: "loratadine", category: "medicine", strength: "10 mg", form: "tablet", cost: 0.25, price: 0.8, level: 200, qty: 800, vat: false, supplier: "MED" },
  { sku: "OMEP-20", name: "Omeprazole 20mg capsules", generic: "omeprazole", category: "medicine", strength: "20 mg", form: "capsule", cost: 0.35, price: 1.2, level: 400, qty: 1600, vat: false, supplier: "MED" },
  { sku: "METF-500", name: "Metformin 500mg tablets", generic: "metformin", category: "medicine", strength: "500 mg", form: "tablet", cost: 0.12, price: 0.4, level: 600, qty: 2400, vat: false, supplier: "MED" },
  { sku: "AMLO-5", name: "Amlodipine 5mg tablets", generic: "amlodipine", category: "medicine", strength: "5 mg", form: "tablet", cost: 0.15, price: 0.5, level: 600, qty: 2400, vat: false, supplier: "MED" },
  { sku: "ATOR-20", name: "Atorvastatin 20mg tablets", generic: "atorvastatin", category: "medicine", strength: "20 mg", form: "tablet", cost: 0.55, price: 1.8, level: 400, qty: 1600, vat: false, supplier: "MED" },
  { sku: "SALB-INH", name: "Salbutamol inhaler 100mcg", generic: "salbutamol", category: "medicine", strength: "100 mcg", form: "inhaler", cost: 9.5, price: 22.0, level: 20, qty: 80, vat: false, supplier: "MED" },
  { sku: "MONT-4", name: "Montelukast 4mg chewable", generic: "montelukast", category: "medicine", strength: "4 mg", form: "chewable tablet", cost: 1.6, price: 4.5, level: 100, qty: 400, vat: false, supplier: "MED" },
  { sku: "ORS-SACH", name: "Oral rehydration salts sachet", generic: "oral rehydration salts", category: "medicine", form: "sachet", cost: 0.9, price: 2.5, level: 200, qty: 800, vat: false, supplier: "MED" },
  { sku: "VITD-50K", name: "Vitamin D3 50,000 IU capsules", generic: "cholecalciferol", category: "medicine", strength: "50,000 IU", form: "capsule", cost: 1.4, price: 4.0, level: 200, qty: 800, vat: false, supplier: "MED" },
  { sku: "FA-5", name: "Folic acid 5mg tablets", generic: "folic acid", category: "medicine", strength: "5 mg", form: "tablet", cost: 0.08, price: 0.3, level: 400, qty: 1600, vat: false, supplier: "MED" },
  { sku: "MEFA-500", name: "Mefenamic acid 500mg tablets", generic: "mefenamic acid", category: "medicine", strength: "500 mg", form: "tablet", cost: 0.35, price: 1.1, level: 200, qty: 800, vat: false, supplier: "MED" },
  { sku: "DICLO-GEL", name: "Diclofenac 1% gel 50g", generic: "diclofenac", category: "medicine", strength: "1%", form: "gel", cost: 8.0, price: 19.0, level: 40, qty: 160, vat: false, supplier: "MED" },
  { sku: "HC-1", name: "Hydrocortisone 1% cream 15g", generic: "hydrocortisone", category: "medicine", strength: "1%", form: "cream", cost: 5.5, price: 14.0, level: 40, qty: 160, vat: false, supplier: "MED" },
  { sku: "CLOT-CR", name: "Clotrimazole 1% cream 20g", generic: "clotrimazole", category: "medicine", strength: "1%", form: "cream", cost: 4.8, price: 12.0, level: 40, qty: 160, vat: false, supplier: "MED" },
  { sku: "TRET-CR", name: "Tretinoin 0.025% cream 20g", generic: "tretinoin", category: "medicine", strength: "0.025%", form: "cream", cost: 24.0, price: 58.0, level: 20, qty: 80, vat: false, supplier: "MED" },
  { sku: "CLIN-GEL", name: "Clindamycin 1% gel 30g", generic: "clindamycin", category: "medicine", strength: "1%", form: "gel", cost: 14.0, price: 34.0, level: 20, qty: 80, vat: false, supplier: "MED" },
  { sku: "CHX-MW", name: "Chlorhexidine 0.12% mouthwash 250ml", generic: "chlorhexidine", category: "medicine", strength: "0.12%", form: "mouthwash", cost: 6.5, price: 16.0, level: 30, qty: 120, vat: false, supplier: "MED" },
  { sku: "PARA-SYR", name: "Paracetamol 120mg/5ml syrup", generic: "paracetamol", category: "medicine", strength: "120 mg/5 ml", form: "syrup", cost: 3.8, price: 10.0, level: 60, qty: 240, vat: false, supplier: "MED" },
  { sku: "IBU-SYR", name: "Ibuprofen 100mg/5ml suspension", generic: "ibuprofen", category: "medicine", strength: "100 mg/5 ml", form: "suspension", cost: 5.2, price: 13.0, level: 40, qty: 160, vat: false, supplier: "MED" },
  { sku: "AMOX-SYR", name: "Amoxicillin 250mg/5ml suspension", generic: "amoxicillin", category: "medicine", strength: "250 mg/5 ml", form: "suspension", cost: 7.5, price: 19.0, level: 40, qty: 160, vat: false, supplier: "MED" },
  { sku: "CETI-SYR", name: "Cetirizine 5mg/5ml syrup", generic: "cetirizine", category: "medicine", strength: "5 mg/5 ml", form: "syrup", cost: 4.5, price: 12.0, level: 40, qty: 160, vat: false, supplier: "MED" },
  { sku: "GLOVE-M", name: "Examination gloves (box of 100)", category: "consumable", cost: 14.0, level: 20, qty: 80, vat: true, supplier: "GEN" },
  { sku: "MASK-3P", name: "Surgical masks 3-ply (box of 50)", category: "consumable", cost: 6.0, level: 20, qty: 80, vat: true, supplier: "GEN" },
  { sku: "SYR-5ML", name: "Syringes 5ml (box of 100)", category: "consumable", cost: 22.0, level: 10, qty: 40, vat: true, supplier: "GEN" },
  { sku: "GAUZE-ST", name: "Sterile gauze swabs (pack)", category: "consumable", cost: 9.0, level: 20, qty: 80, vat: true, supplier: "GEN" },
  { sku: "TUBE-EDTA", name: "Blood collection tubes EDTA (box of 100)", category: "consumable", cost: 48.0, level: 6, qty: 24, vat: true, supplier: "GEN" },
  { sku: "IVSET", name: "IV giving set", category: "consumable", cost: 4.5, level: 40, qty: 160, vat: true, supplier: "GEN" },
  { sku: "DEN-COMP", name: "Dental composite syringe A2", category: "consumable", cost: 62.0, level: 8, qty: 32, vat: true, supplier: "DEN" },
  { sku: "DEN-LIDO", name: "Lidocaine 2% dental cartridges (box of 50)", category: "consumable", cost: 85.0, level: 6, qty: 24, vat: true, supplier: "DEN" },
  { sku: "DEN-BUR", name: "Dental burs assorted (pack)", category: "consumable", cost: 70.0, level: 5, qty: 20, vat: true, supplier: "DEN" },
];
export const CONSUMABLE_USE: Record<string, number> = { "GLOVE-M": 0.045, "MASK-3P": 0.04, "SYR-5ML": 0.012, "GAUZE-ST": 0.05, "TUBE-EDTA": 0.006, "IVSET": 0.05, "DEN-COMP": 0.012, "DEN-LIDO": 0.006, "DEN-BUR": 0.003 };
export const SUPPLIERS: Record<string, { name: string; trn: string; terms: number; prefix: string }> = {
  MED: { name: "Emirates Pharma Distribution FZ-LLC", trn: "100312848700003", terms: 60, prefix: "EPD" },
  DEN: { name: "Dubai Dental Depot LLC", trn: "100287465500003", terms: 30, prefix: "DDD" },
  GEN: { name: "Al Noor Medical Supplies LLC", trn: "100455219600003", terms: 30, prefix: "ANM" },
};

// ---------- Insurance ----------
export type PlanDef = { key: string; payer: string; name: string; copay: number; cap?: string; noDental?: boolean; weight: number; days: number; prefix: string };
export const PAYERS: Record<string, { name: string; kind: "insurer" | "tpa" }> = {
  DAMAN: { name: "National Health Insurance Company - Daman", kind: "insurer" },
  NAS: { name: "NAS Administration Services (Neuron)", kind: "tpa" },
  SUKOON: { name: "Sukoon Insurance (Oman Insurance)", kind: "insurer" },
  GIG: { name: "GIG Gulf", kind: "insurer" },
  CIGNA: { name: "Cigna Middle East", kind: "insurer" },
  METLIFE: { name: "MetLife Alico", kind: "insurer" },
  ORIENT: { name: "Orient Insurance", kind: "insurer" },
};
export const PLANS: PlanDef[] = [
  { key: "daman-enh", payer: "DAMAN", name: "Daman Enhanced", copay: 20, cap: "50.00", weight: 14, days: 32, prefix: "DAM" },
  { key: "daman-basic", payer: "DAMAN", name: "Daman Essential Benefits Plan", copay: 20, cap: "50.00", noDental: true, weight: 12, days: 32, prefix: "DAM" },
  { key: "daman-thiqa", payer: "DAMAN", name: "Daman Thiqa (UAE nationals)", copay: 0, weight: 8, days: 30, prefix: "THQ" },
  { key: "nas-gold", payer: "NAS", name: "NAS Gold Network", copay: 10, cap: "30.00", weight: 10, days: 45, prefix: "NAS" },
  { key: "nas-silver", payer: "NAS", name: "NAS Silver Network", copay: 20, cap: "50.00", noDental: true, weight: 8, days: 45, prefix: "NAS" },
  { key: "sukoon-silver", payer: "SUKOON", name: "Sukoon Silver", copay: 20, cap: "50.00", weight: 10, days: 58, prefix: "OIC" },
  { key: "gig-classic", payer: "GIG", name: "GIG Gulf Classic", copay: 20, cap: "50.00", weight: 9, days: 50, prefix: "GIG" },
  { key: "cigna-gold", payer: "CIGNA", name: "Cigna Gold", copay: 10, cap: "25.00", weight: 8, days: 40, prefix: "CGN" },
  { key: "metlife-plus", payer: "METLIFE", name: "MetLife Plus", copay: 15, cap: "40.00", weight: 6, days: 46, prefix: "MET" },
  { key: "orient-basic", payer: "ORIENT", name: "Orient Basic", copay: 20, cap: "50.00", noDental: true, weight: 5, days: 55, prefix: "ORI" },
];
export const DENIAL_REASONS = [
  "Pre-authorisation required and not on file", "Service not covered under plan schedule of benefits", "Member not eligible on date of service",
  "Duplicate claim submission", "Diagnosis not consistent with service rendered", "Clinical information required",
];

// ---------- CRM text ----------
export const COMMENTS = [
  "Very professional staff and a short wait.", "Doctor explained everything clearly.", "Clean clinic, friendly reception.", "Quick appointment and easy parking.",
  "Good service but the waiting time was a little long.", "Billing was clear and insurance handled smoothly.", "Excellent dentist, painless treatment.", "My child felt comfortable with the paediatrician.",
  "Would recommend to friends and family.", "The follow-up reminder was helpful.",
];
export const COMPLAINTS: [string, string, string][] = [
  ["Waiting time", "Patient waited about 45 minutes beyond the appointment time and was not updated.", "Apologised to the patient. Added a second check-in desk during peak hours and a delay notice process."],
  ["Billing query", "Patient questioned the insurance co-payment amount on the invoice.", "Explained plan co-pay and per-visit cap; invoice reviewed and confirmed correct."],
  ["Staff attitude", "Patient felt the front desk was dismissive when asking about charges.", "Feedback shared with the team, customer-service refresher completed."],
  ["Appointment scheduling", "Appointment was moved without notice.", "Reminder and reschedule notification process reinforced; patient offered priority slot."],
  ["Cleanliness", "Patient reported the waiting-area washroom needed attention.", "Housekeeping checklist frequency increased."],
];
export const ENQUIRY_INTERESTS = ["Dental check-up", "Teeth whitening", "Acne treatment", "Botox consultation", "Child vaccination", "Antenatal package", "Health screening package", "Skin consultation", "Insurance coverage query", "Root canal treatment", "Hair loss treatment", "Medical fitness for visa"];
export const ENQUIRY_CHANNELS: [string, string][] = [["instagram", "instagram"], ["whatsapp", "google"], ["phone", "google"], ["walk-in", "walk-in"], ["website form", "website"], ["facebook", "facebook"], ["phone", "referral"]];
