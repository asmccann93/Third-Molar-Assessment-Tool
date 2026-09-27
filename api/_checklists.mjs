/**
 * AI Notes — procedure checklists
 * oralsurgeryassess.com/ai-notes/
 *
 * Deploy to: api/_checklists.mjs   (underscore keeps it off Vercel's route table)
 *
 * THIS IS CLINICAL CONTENT. It was drafted by the assistant on 2 September 2026
 * for the clinician to correct.
 *
 *   third-molar         reviewed by AM, 5 September 2026
 *   implant-consult     reviewed by AM, 5 September 2026 — all 20 kept as drafted
 *   extraction-surgery  reviewed by AM, 5 September 2026 — all 13 kept as drafted
 *   sedation            EXPANDED 5 September 2026 at AM's request (7 -> 19)
 *   implant-surgery     EXPANDED 5 September 2026 at AM's request (5 -> 15)
 *
 *   exam-recall, emergency, perio, restorative, endo, treatment-plan
 *                       DRAFTED 27 September 2026 at AM's request — NOT YET
 *                       REVIEWED. Until 27 September these six types had no
 *                       checklist at all, so "no gaps flagged" meant nothing
 *                       had been looked for. exam-recall and emergency are
 *                       RECORD-KEEPING lists, built on the headings of the
 *                       CGDent (formerly FGDP(UK)) guidance on clinical
 *                       examination and record-keeping: what a record of that
 *                       appointment is expected to contain, said to the
 *                       patient or dictated. The other four are consent lists
 *                       like the surgical ones. Every word is the assistant's
 *                       draft; each carries `reviewed: false`, and the page
 *                       says so under the list, until AM has been through it.
 *
 *                       For these two, AM specified WHAT was missing — fitness
 *                       for sedation, the escort staying, surgical risks and
 *                       implant post-op — and approved the result. The wording
 *                       of each new item is the assistant's. If one reads
 *                       oddly on a real case, that is why.
 *
 * For an unreviewed type, "no gaps flagged" means "nothing the draft list
 * looked for was missing", not a clinical all-clear. Nothing here is advice to
 * the patient and nothing here ever reaches the note as a fact. Each item is a
 * question the tool asks of the transcript:
 * "was this said?" If it was not, the item becomes a gap in the clinician's
 * own words below — the model never supplies the missing content itself.
 *
 * Structure per consult type:
 *   key      stable identifier the model reports against
 *   ask      what the model is looking for in the transcript (its instruction)
 *   gap      what the clinician sees if it was not found (his wording, not the model's)
 *
 * Deliberately no figures. A checklist asks whether a risk was named, not what
 * number was put on it; the number is the clinician's to say and to stand by.
 *
 * Lead-ins the page understands: "Not mentioned:", "Not asked about:",
 * "Not offered:", and since 27 September "Not recorded:" for a record-keeping
 * item, which may be found in the conversation OR in the dictation. A condition
 * goes after a comma ("Not recorded, for a prescription: ...").
 */

const MH = {
  anticoagulants: {
    key: 'mh-anticoagulants',
    ask: 'Anticoagulant or antiplatelet medication was asked about or discussed (warfarin, DOACs, aspirin, clopidogrel).',
    gap: 'Not asked about: anticoagulants or antiplatelets.'
  },
  antiresorptives: {
    key: 'mh-antiresorptives',
    ask: 'Bisphosphonates, denosumab or other antiresorptive medication, or the risk of osteonecrosis, was asked about or discussed.',
    gap: 'Not asked about: bisphosphonates, denosumab or other antiresorptives.'
  },
  diabetes: {
    key: 'mh-diabetes',
    ask: 'Diabetes, or its control, was asked about or discussed.',
    gap: 'Not asked about: diabetes.'
  },
  smoking: {
    key: 'mh-smoking',
    ask: 'Smoking or vaping was asked about or discussed.',
    gap: 'Not asked about: smoking.'
  },
  bleeding: {
    key: 'mh-bleeding',
    ask: 'A bleeding disorder, or a history of prolonged bleeding after previous extractions or surgery, was asked about.',
    gap: 'Not asked about: bleeding tendency or previous problems with bleeding.'
  },
  immunosuppression: {
    key: 'mh-immunosuppression',
    ask: 'Immunosuppression, steroids, or chemotherapy was asked about or discussed.',
    gap: 'Not asked about: immunosuppression or steroids.'
  },
  radiotherapy: {
    key: 'mh-radiotherapy',
    ask: 'Previous radiotherapy to the head or neck was asked about.',
    gap: 'Not asked about: previous head and neck radiotherapy.'
  },
  allergies: {
    key: 'mh-allergies',
    ask: 'Allergies were asked about or confirmed.',
    gap: 'Not asked about: allergies.'
  },
};

/* Record-keeping items shared by the exam and emergency lists (27 Sep 2026,
   drafted, not reviewed). Found if said to the patient OR dictated. */
const RK = {
  mh: {
    key: 'rk-mh',
    ask: 'The medical history was checked or updated at this visit — asked about with the patient, or said or dictated as checked, updated or unchanged.',
    gap: 'Not recorded: medical history checked or updated.'
  },
  radiographs: {
    key: 'rk-radiographs',
    ask: 'Radiographs were mentioned, said or dictated: taken, with why and what they showed; or not taken, with why (not needed, not due).',
    gap: 'Not recorded: radiographs — why taken and what they showed, or why none were taken.'
  },
};

export const CHECKLISTS = {
  'third-molar': {
    label: 'Third molar surgery',
    items: [
      // risks the clinician should have NAMED
      { key: 'pain-swelling',  ask: 'The clinician told the patient to expect pain, swelling and bruising afterwards.', gap: 'Not mentioned: post-operative pain, swelling and bruising.' },
      { key: 'bleeding',       ask: 'The clinician mentioned bleeding as a risk or as something to expect.', gap: 'Not mentioned: bleeding.' },
      { key: 'infection',      ask: 'The clinician mentioned infection or a dry socket.', gap: 'Not mentioned: infection or dry socket.' },
      { key: 'trismus',        ask: 'The clinician mentioned limited mouth opening (trismus) afterwards.', gap: 'Not mentioned: limited mouth opening afterwards.' },
      { key: 'ian',            ask: 'The clinician named the risk of altered sensation, numbness or tingling of the lip and chin (inferior alveolar nerve), and whether it can be temporary or permanent.', gap: 'Not mentioned: altered sensation of the lip and chin (inferior alveolar nerve), temporary or permanent.' },
      { key: 'lingual',        ask: 'The clinician named the risk of altered sensation or taste on the tongue (lingual nerve).', gap: 'Not mentioned: altered sensation or taste on the tongue (lingual nerve).' },
      { key: 'sinus',          ask: 'For an UPPER third molar, the clinician mentioned the maxillary sinus — an opening into it (oro-antral communication), or a root displaced into it. If the tooth in question is a lower, where it does not apply, report it as not applicable.', gap: 'Not mentioned, for an upper tooth: the sinus, an opening into it, or a root displaced into it.' },
      { key: 'adjacent',       ask: 'The clinician mentioned possible damage to the adjacent tooth or its restoration.', gap: 'Not mentioned: damage to the adjacent tooth or filling.' },
      { key: 'root-fragment',  ask: 'The clinician mentioned that a root fragment may fracture and be left, or that removal may be incomplete or need referral.', gap: 'Not mentioned: possible root fracture, retained fragment, or need for referral.' },
      // alternatives the clinician should have OFFERED
      { key: 'alt-none',       ask: 'Leaving the tooth and monitoring it was offered as an alternative.', gap: 'Not offered: leaving the tooth and monitoring.' },
      { key: 'alt-coronectomy', ask: 'Coronectomy was mentioned as an alternative, or the clinician explained why it was not appropriate.', gap: 'Not mentioned: coronectomy as an alternative (or why not).' },
      { key: 'alt-sedation',   ask: 'The option of sedation or general anaesthetic, or referral for it, was mentioned.', gap: 'Not mentioned: sedation or general anaesthetic as an option.' },
      // aftercare
      { key: 'aftercare',      ask: 'Post-operative instructions were given or promised in writing, including analgesia and when to seek help.', gap: 'Not mentioned: post-operative instructions, analgesia, or when to seek help.' },
      { key: 'time-off',       ask: 'Time off work or normal activities afterwards was discussed.', gap: 'Not mentioned: time off work or normal activities.' },
      // No medical-history items here. Reviewed by AM, 5 September 2026: the
      // history is taken and recorded before the consent discussion begins, so
      // checking the consent transcript for it flagged omissions that were not
      // omissions. The other consult types still carry the MH items they need.
    ]
  },

  'extraction-surgery': {
    label: 'Extraction / surgery',
    items: [
      { key: 'pain-swelling',  ask: 'The clinician told the patient to expect pain, swelling or bruising afterwards.', gap: 'Not mentioned: post-operative pain and swelling.' },
      { key: 'bleeding',       ask: 'The clinician mentioned bleeding.', gap: 'Not mentioned: bleeding.' },
      { key: 'infection',      ask: 'The clinician mentioned infection or a dry socket.', gap: 'Not mentioned: infection or dry socket.' },
      { key: 'adjacent',       ask: 'The clinician mentioned possible damage to adjacent teeth or restorations.', gap: 'Not mentioned: damage to adjacent teeth or fillings.' },
      { key: 'root-fragment',  ask: 'The clinician mentioned that a root may fracture and need surgical removal, or be left, or need referral.', gap: 'Not mentioned: root fracture, surgical removal, or referral.' },
      { key: 'nerve-sinus',    ask: 'For a lower tooth, altered sensation of lip, chin or tongue was mentioned; for an upper back tooth, involvement of the sinus was mentioned. Report found if the relevant one for the tooth in question was mentioned.', gap: 'Not mentioned: nerve involvement (lower) or sinus involvement (upper), as relevant to the tooth.' },
      { key: 'alt-none',       ask: 'Leaving the tooth was offered as an alternative, or the reason it is not an option was given.', gap: 'Not offered: leaving the tooth (or why not).' },
      { key: 'alt-restore',    ask: 'Saving the tooth — root canal treatment, restoration, or referral — was mentioned as an alternative, or why it is not possible.', gap: 'Not mentioned: whether the tooth could be saved instead.' },
      { key: 'aftercare',      ask: 'Post-operative instructions were given or promised, including when to seek help.', gap: 'Not mentioned: post-operative instructions or when to seek help.' },
      MH.anticoagulants, MH.antiresorptives, MH.bleeding, MH.allergies,
    ]
  },

  'implant-consult': {
    label: 'Implant consult',
    items: [
      { key: 'failure',        ask: 'The clinician explained that the implant may fail to integrate or may be lost later.', gap: 'Not mentioned: the implant may fail to integrate or be lost.' },
      { key: 'peri-implantitis', ask: 'The clinician mentioned infection or bone loss around the implant (peri-implantitis) and the need for maintenance.', gap: 'Not mentioned: peri-implantitis and the need for lifelong maintenance.' },
      { key: 'nerve-sinus',    ask: 'For a lower posterior site, altered sensation of the lip and chin was mentioned; for an upper posterior site, the sinus was mentioned. Report found if the one relevant to the site was mentioned.', gap: 'Not mentioned: nerve injury (lower) or sinus involvement (upper), as relevant to the site.' },
      { key: 'adjacent',       ask: 'Possible damage to adjacent teeth or roots was mentioned.', gap: 'Not mentioned: damage to adjacent teeth or roots.' },
      { key: 'aesthetic',      ask: 'Gum recession, bone loss around the implant, or a compromised appearance was mentioned.', gap: 'Not mentioned: recession, bone loss, or the appearance not being as expected.' },
      { key: 'grafting',       ask: 'The possible need for bone grafting or a sinus lift was mentioned, or ruled out.', gap: 'Not mentioned: whether grafting or a sinus lift may be needed.' },
      { key: 'mechanical',     ask: 'Mechanical complications — screw loosening, crown chipping or fracture, the restoration needing replacement over time — were mentioned.', gap: 'Not mentioned: screw loosening, chipping, or the crown needing replacement in time.' },
      { key: 'timeline',       ask: 'The staging and overall timeline — surgery, healing period, restoration — was explained.', gap: 'Not mentioned: the stages and how long the whole process takes.' },
      { key: 'costs-full',     ask: 'The full cost was discussed, including the crown and any grafting, not just the implant.', gap: 'Not mentioned: the full cost including the restoration and any grafting.' },
      { key: 'guarantee',      ask: 'Any guarantee, or the absence of one, and what happens if the implant fails, was discussed.', gap: 'Not mentioned: what happens if it fails, and any guarantee.' },
      { key: 'alt-none',       ask: 'Leaving the space was offered as an alternative.', gap: 'Not offered: leaving the space.' },
      { key: 'alt-denture',    ask: 'A denture was mentioned as an alternative.', gap: 'Not offered: a denture as an alternative.' },
      { key: 'alt-bridge',     ask: 'A bridge — conventional or resin-bonded — was mentioned as an alternative.', gap: 'Not offered: a bridge as an alternative.' },
      { key: 'hygiene',        ask: 'The patient\u2019s oral hygiene and gum health, and their part in the outcome, were discussed.', gap: 'Not mentioned: oral hygiene and gum health as a condition of success.' },
      MH.smoking, MH.diabetes, MH.antiresorptives, MH.anticoagulants, MH.radiotherapy, MH.immunosuppression,
    ]
  },

  'implant-surgery': {
    label: 'Implant surgery',
    // Mostly dictated. The checklist is what the CONVERSATION on the day should still cover.
    items: [
      { key: 'consent-confirmed', ask: 'The clinician confirmed on the day that the patient still wished to proceed and had no new questions.', gap: 'Not mentioned: consent re-confirmed on the day.' },
      { key: 'risks-revisited', ask: 'The main risks were revisited on the day, not only referred back to the consultation.', gap: 'Not mentioned: the main risks revisited on the day.' },

      // Surgical risks. Added 5 September 2026 at AM's request: the list assumed
      // the consult had covered everything, which is a poor assumption when the
      // consult may have been months earlier.
      { key: 'pain-swelling',  ask: 'The clinician told the patient to expect pain, swelling and bruising afterwards.', gap: 'Not mentioned: post-operative pain, swelling and bruising.' },
      { key: 'bleeding',       ask: 'The clinician mentioned bleeding from the surgical site.', gap: 'Not mentioned: bleeding.' },
      { key: 'infection',      ask: 'The clinician mentioned infection of the surgical site or the implant.', gap: 'Not mentioned: infection of the site or the implant.' },
      { key: 'nerve-sinus',    ask: 'For a lower posterior site, altered sensation of the lip and chin was mentioned; for an upper posterior site, the sinus was mentioned. Report found if the one relevant to the site was mentioned.', gap: 'Not mentioned: nerve injury (lower) or sinus involvement (upper), as relevant to the site.' },
      { key: 'site-not-usable', ask: 'What happens if the site cannot take the implant once opened \u2014 abandoning, grafting, or placing it later \u2014 was discussed.', gap: 'Not mentioned: what happens if the site cannot take the implant on the day.' },
      { key: 'early-failure',  ask: 'The clinician mentioned that the implant may fail to integrate in the healing period.', gap: 'Not mentioned: the implant may fail to integrate while healing.' },

      // Post-operative instructions specific to a healing implant.
      { key: 'aftercare',      ask: 'Post-operative instructions were given, including analgesia, hygiene around the site, and when to seek help.', gap: 'Not mentioned: post-operative instructions.' },
      { key: 'site-care',      ask: 'Care of the site itself was explained \u2014 not disturbing it, how to clean around it, and any mouthwash.', gap: 'Not mentioned: how to care for and clean around the site while it heals.' },
      { key: 'diet-smoking',   ask: 'Diet afterwards, and avoiding smoking during healing, were discussed.', gap: 'Not mentioned: soft diet, and not smoking while it heals.' },
      { key: 'provisional',    ask: 'Whether a temporary restoration or an existing denture can be worn over the site, and any adjustment needed, was discussed.', gap: 'Not mentioned: whether a temporary or existing denture can be worn over the site.' },
      { key: 'review',         ask: 'A review appointment or the next stage was arranged.', gap: 'Not mentioned: review or next stage.' },
      MH.anticoagulants, MH.allergies,
    ]
  },

  sedation: {
    label: 'Sedation',
    // Expanded 5 September 2026 at AM's request, from five items plus history.
    // Fitness for sedation was absent entirely, which mattered because the site
    // has a separate ASA tool and this list read as though it did not exist.
    items: [
      { key: 'technique',      ask: 'The sedation technique and what the patient will experience were explained.', gap: 'Not mentioned: what the sedation involves and what the patient will feel.' },
      { key: 'amnesia',        ask: 'The patient was told they may not remember the treatment.', gap: 'Not mentioned: that they may not remember the treatment.' },
      { key: 'sedation-limits', ask: 'What happens if the sedation is not enough, or the patient cannot tolerate the treatment under it, was discussed \u2014 stopping, rescheduling, or referral.', gap: 'Not mentioned: what happens if the sedation is not enough or is not tolerated.' },
      { key: 'alt-sedation',   ask: 'Alternatives to sedation were mentioned \u2014 treatment under local anaesthetic alone, or referral for general anaesthetic.', gap: 'Not offered: local anaesthetic alone, or general anaesthetic, as alternatives.' },
      { key: 'separate-consent', ask: 'The dental treatment itself was discussed and agreed, separately from agreeing to the sedation.', gap: 'Not clear: the treatment itself was agreed, separately from the sedation.' },

      { key: 'eating',         ask: 'Instructions about eating and drinking before the appointment were given.', gap: 'Not mentioned: eating and drinking before the appointment.' },
      { key: 'meds-on-the-day', ask: 'Whether to take their usual medication on the day was discussed.', gap: 'Not mentioned: whether to take their usual medication on the day.' },

      { key: 'escort',         ask: 'The need for a responsible adult escort was discussed.', gap: 'Not mentioned: the escort requirement.' },
      { key: 'escort-stays',   ask: 'The patient was told the escort must STAY WITH THEM afterwards, not simply take them home.', gap: 'Not mentioned: that the escort must stay with them afterwards, not just take them home.' },
      { key: 'recovery',       ask: 'How long they will be kept in recovery, and how they will feel for the rest of the day, was explained.', gap: 'Not mentioned: recovery time and how they will feel afterwards.' },
      { key: 'no-driving',     ask: 'The patient was told not to drive, operate machinery, or make important decisions for the rest of the day, or the stated period.', gap: 'Not mentioned: no driving or important decisions afterwards.' },
      { key: 'responsibilities', ask: 'Care of children or dependants, and time off work, after the appointment was discussed.', gap: 'Not mentioned: childcare, dependants, or time off work afterwards.' },

      { key: 'mh-fitness',     ask: 'The patient\u2019s general fitness for sedation was assessed or discussed \u2014 an ASA grade, or their general health and any heart or chest problems.', gap: 'Not asked about: general fitness for sedation (ASA grade, heart or chest problems).' },
      { key: 'mh-airway',      ask: 'Snoring, sleep apnoea, or any airway or breathing problem was asked about.', gap: 'Not asked about: snoring, sleep apnoea, or breathing problems.' },
      { key: 'mh-weight',      ask: 'Weight or body mass index was asked about or recorded, where it affects the sedation.', gap: 'Not asked about: weight or BMI.' },
      { key: 'mh-pregnancy',   ask: 'Pregnancy or breastfeeding was asked about, where it applies.', gap: 'Not asked about: pregnancy or breastfeeding.' },
      { key: 'mh-sedating-meds', ask: 'Other medication that may interact with sedation was asked about \u2014 opioids, benzodiazepines, antidepressants, or recreational drugs and alcohol.', gap: 'Not asked about: other sedating medication, alcohol or recreational drugs.' },
      MH.allergies, MH.anticoagulants,
    ]
  },
};

/* ---- 27 September 2026: the six types that had no checklist. DRAFTS. ---- */
Object.assign(CHECKLISTS, {
  'exam-recall': {
    label: 'Exam / recall',
    reviewed: false,
    items: [
      { key: 'rk-concerns',   ask: 'The patient was asked whether they had any problems or concerns, or it was said or dictated that they had none.', gap: 'Not recorded: whether the patient had any concerns.' },
      RK.mh,
      { key: 'rk-social',     ask: 'Smoking or other tobacco use, and alcohol, were asked about, said or dictated.', gap: 'Not recorded: smoking and alcohol.' },
      { key: 'rk-extraoral',  ask: 'An extra-oral examination was said or dictated (face, lymph nodes, jaw joints or muscles), a normal finding included.', gap: 'Not recorded: extra-oral examination.' },
      { key: 'rk-softtissue', ask: 'An intra-oral soft tissue examination was said or dictated (cheeks, tongue, floor of mouth, palate, throat), a normal finding included.', gap: 'Not recorded: intra-oral soft tissue examination.' },
      { key: 'rk-perio',      ask: 'BPE scores or another periodontal assessment were said or dictated, or the reason none was done.', gap: 'Not recorded: BPE or periodontal assessment.' },
      { key: 'rk-teeth',      ask: 'Findings for the teeth were said or dictated — caries, restorations, wear, or that nothing had changed.', gap: 'Not recorded: findings for the teeth.' },
      RK.radiographs,
      { key: 'rk-risk',       ask: 'The patient\'s risk of caries, gum disease or oral cancer was assessed or stated, said or dictated (for example "low caries risk").', gap: 'Not recorded: risk assessment (caries, gum disease, oral cancer).' },
      { key: 'rk-advice',     ask: 'The clinician gave the patient oral hygiene or prevention advice (brushing, cleaning between the teeth, fluoride, diet, smoking or alcohol).', gap: 'Not mentioned: oral hygiene or prevention advice.' },
      { key: 'rk-plan',       ask: 'The treatment needed was said or dictated, or that none is needed.', gap: 'Not recorded: treatment needed, or that none is needed.' },
      { key: 'rk-recall',     ask: 'A recall interval was said or dictated (for example "see you in six months").', gap: 'Not recorded: recall interval.' },
    ]
  },

  emergency: {
    label: 'Emergency',
    reviewed: false,
    items: [
      { key: 'em-history',    ask: 'The problem was described, said or dictated: where it is, how long it has been going on, and what it is like.', gap: 'Not recorded: the history of the problem (where, how long, what it is like).' },
      RK.mh,
      { key: 'em-exam',       ask: 'Examination findings for the area of concern were said or dictated.', gap: 'Not recorded: examination of the problem area.' },
      RK.radiographs,
      { key: 'em-diagnosis',  ask: 'A diagnosis or working diagnosis was said or dictated.', gap: 'Not recorded: a diagnosis or working diagnosis.' },
      { key: 'em-options',    ask: 'The clinician explained the options for dealing with it, including what would happen if it were left.', gap: 'Not mentioned: the options, including leaving it.' },
      { key: 'em-done',       ask: 'What was done today, or that nothing was done, was said or dictated.', gap: 'Not recorded: what was done today.' },
      { key: 'em-rx',         ask: 'Whether a medicine was prescribed or advised was said or dictated — that none was, or if one was, its name, dose and how long to take it. Silence about medicines is not found.', gap: 'Not recorded: whether a medicine was prescribed, and if so the name, dose and how long.' },
      { key: 'em-worse',      ask: 'The clinician told the patient what to do if it gets worse, or when to get in touch.', gap: 'Not mentioned: what to do if it gets worse.' },
      { key: 'em-followup',   ask: 'Follow-up or definitive treatment was arranged or advised, said or dictated.', gap: 'Not recorded: follow-up or definitive treatment.' },
    ]
  },

  perio: {
    label: 'Perio',
    reviewed: false,
    items: [
      { key: 'pe-scores',     ask: 'BPE scores or pocket charting were said or dictated.', gap: 'Not recorded: BPE or pocket charting.' },
      { key: 'pe-diagnosis',  ask: 'A periodontal diagnosis was said or dictated (for example a stage and grade, or gingivitis).', gap: 'Not recorded: periodontal diagnosis.' },
      MH.smoking, MH.diabetes,
      { key: 'pe-ohi',        ask: 'The clinician gave oral hygiene advice, including cleaning between the teeth.', gap: 'Not mentioned: oral hygiene advice, including cleaning between the teeth.' },
      { key: 'pe-role',       ask: 'The clinician explained that the outcome depends on the patient\'s own cleaning (and on not smoking, where that applies).', gap: 'Not mentioned: that the outcome depends on the patient\'s own cleaning.' },
      { key: 'pe-stabilise',  ask: 'The clinician explained that treatment controls the disease rather than curing it, or that it can come back.', gap: 'Not mentioned: that treatment controls rather than cures, and it can come back.' },
      { key: 'pe-after',      ask: 'The clinician mentioned what treatment can leave behind: sensitivity, gums shrinking back, or gaps appearing between the teeth.', gap: 'Not mentioned: sensitivity, gums shrinking back or gaps between the teeth after treatment.' },
      { key: 'pe-untreated',  ask: 'The clinician explained what could happen if it is not treated (for example teeth loosening or being lost).', gap: 'Not mentioned: what could happen if it is not treated.' },
      { key: 'pe-review',     ask: 'A review or re-assessment after treatment was mentioned.', gap: 'Not mentioned: review after treatment.' },
    ]
  },

  restorative: {
    label: 'Restorative',
    reviewed: false,
    items: [
      { key: 're-options',    ask: 'The clinician explained the options for restoring the tooth (for example different filling materials, an onlay or a crown), or why there is only one.', gap: 'Not mentioned: the options for restoring the tooth.' },
      { key: 're-none',       ask: 'Leaving the tooth untreated was offered as an option, or the reason it is not was given.', gap: 'Not offered: leaving it untreated (or why not).' },
      { key: 're-material',   ask: 'The material to be used was discussed, with how it looks or how long it may last.', gap: 'Not mentioned: the material, and how long it may last.' },
      { key: 're-sensitivity', ask: 'Sensitivity or discomfort afterwards was mentioned.', gap: 'Not mentioned: sensitivity afterwards.' },
      { key: 're-nerve',      ask: 'The clinician mentioned that the nerve may need root canal treatment later, or that the tooth could be lost.', gap: 'Not mentioned: possible root canal treatment later, or loss of the tooth.' },
      { key: 're-breakage',   ask: 'The clinician mentioned that the tooth or the restoration could break, or need replacing in future.', gap: 'Not mentioned: the tooth or restoration may break or need replacing.' },
    ]
  },

  endo: {
    label: 'Endo',
    reviewed: false,
    items: [
      { key: 'en-success',    ask: 'The chance of success was discussed, or that it may not work.', gap: 'Not mentioned: the chance of success, or that it may not work.' },
      { key: 'en-visits',     ask: 'The number of visits was mentioned.', gap: 'Not mentioned: number of visits.' },
      { key: 'en-flareup',    ask: 'Pain or a flare-up after treatment was mentioned.', gap: 'Not mentioned: pain or a flare-up after treatment.' },
      { key: 'en-procedural', ask: 'The clinician mentioned that an instrument could separate, the root could be perforated, or the treatment might not be completed.', gap: 'Not mentioned: a separated instrument, a perforation, or treatment not being completed.' },
      { key: 'en-restoration', ask: 'The clinician explained that the tooth will need a permanent filling or crown afterwards, or that it may fracture without one.', gap: 'Not mentioned: the permanent filling or crown needed afterwards.' },
      { key: 'en-alt-extract', ask: 'Extraction was offered as an alternative, or the reason it is not suitable was given.', gap: 'Not offered: extraction as the alternative.' },
      { key: 'en-alt-none',   ask: 'No treatment, and what it would mean, was mentioned.', gap: 'Not offered: no treatment, and what that would mean.' },
      { key: 'en-referral',   ask: 'Referral to a specialist was mentioned as an option, or why not.', gap: 'Not mentioned: referral to a specialist (or why not).' },
    ]
  },

  'treatment-plan': {
    label: 'Treatment plan consult',
    reviewed: false,
    items: [
      { key: 'tp-options',    ask: 'More than one option was described, or the clinician explained why there is only one.', gap: 'Not mentioned: the options, or why there is only one.' },
      { key: 'tp-none',       ask: 'Doing nothing, and what it would mean, was mentioned.', gap: 'Not offered: no treatment, and what that would mean.' },
      { key: 'tp-risks',      ask: 'The main risks or drawbacks of the options were described.', gap: 'Not mentioned: the risks or drawbacks of the options.' },
      { key: 'tp-costs',      ask: 'The cost of the options was discussed, or whether they are NHS or private.', gap: 'Not mentioned: the cost of each option (NHS or private).' },
      { key: 'tp-sequence',   ask: 'The order of treatment or the number of visits was described.', gap: 'Not mentioned: order of treatment or number of visits.' },
      { key: 'tp-longevity',  ask: 'How long the treatment may last, or the maintenance it needs, was discussed.', gap: 'Not mentioned: how long it may last, or the maintenance it needs.' },
      { key: 'tp-time',       ask: 'The patient was offered time to think it over, or a written plan.', gap: 'Not offered: time to think it over, or a written plan.' },
    ]
  },
});

/** A checklist nobody has reviewed yet. The page says so beneath the list. */
export function checklistIsDraft(consultTypeKey) {
  if (typeof consultTypeKey !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(CHECKLISTS, consultTypeKey)) return false;
  return CHECKLISTS[consultTypeKey].reviewed === false;
}

/** Keys the model must report against for a given consult type; [] if none.
 *  Own-property lookup only: consultType arrives from the client, and a value
 *  like "constructor" or "__proto__" would otherwise return something off
 *  Object.prototype, whose .items is undefined — which threw and lost the
 *  whole consultation before the model was ever called. */
export function checklistFor(consultTypeKey) {
  if (typeof consultTypeKey !== 'string') return [];
  if (!Object.prototype.hasOwnProperty.call(CHECKLISTS, consultTypeKey)) return [];
  const c = CHECKLISTS[consultTypeKey];
  return Array.isArray(c?.items) ? c.items : [];
}

/**
 * The checklist as the clinician reads it, for the page to show DURING the
 * recording (added 27 September 2026 at the clinical lead's request). Built from
 * the `gap` wording, which is the clinician's own, with its "Not mentioned:" /
 * "Not asked about:" / "Not offered:" lead-in taken off, so it reads as a topic
 * ("Bleeding", "Leaving the tooth and monitoring"). No new wording is written
 * here: a topic is always the tail of a reviewed gap line.
 */
export function checklistTopic(gap) {
  const s = String(gap || '').trim();
  const m = s.match(/^Not [a-z ]{1,30}?(?:,\s*(for [^:]{1,40}))?:\s*(.+)$/i);
  let t = (m ? m[2] : s).replace(/[.\s]+$/, '').trim();
  if (!t) return '';
  t = t.charAt(0).toUpperCase() + t.slice(1);
  // "Not mentioned, for an upper tooth: the sinus ..." keeps its condition.
  return m && m[1] ? `${t} (${m[1].trim()})` : t;
}

export function checklistTopics(consultTypeKey) {
  return checklistFor(consultTypeKey).map((i) => ({ key: i.key, topic: checklistTopic(i.gap) })).filter((i) => i.topic);
}

/**
 * Did the model actually report against the checklist at all? An empty or
 * unrecognisable report is a MODEL failure, not evidence that every item on the
 * list went unsaid. Emitting a false "not mentioned" line for each of them would
 * be worse than emitting none: the clinician learns the gap list cries wolf, and
 * stops reading the one that matters.
 */
export function checklistReported(consultTypeKey, report) {
  const items = checklistFor(consultTypeKey);
  if (!items.length) return true;
  if (!report || typeof report !== 'object') return false;
  return items.some((i) => Object.prototype.hasOwnProperty.call(report, i.key));
}

/**
 * Turn the model's report into gaps, in the clinician's wording.
 * `report` is { key: evidence | null }. Anything null, missing, or not a
 * non-empty string counts as not found. Keys the checklist does not know are
 * ignored: the model cannot invent a checklist item.
 */
export function checklistGaps(consultTypeKey, report) {
  const items = checklistFor(consultTypeKey);
  if (!items.length) return [];
  if (!checklistReported(consultTypeKey, report)) {
    return ['The procedure checklist could not be applied to this transcript, so nothing below has been ' +
            'checked against it. Read the note against what you remember discussing.'];
  }
  const r = report && typeof report === 'object' ? report : {};
  const gaps = [];
  for (const item of items) {
    const v = r[item.key];
    const found = typeof v === 'string' && v.trim().length > 0 && !isNegative(v);
    if (!found) gaps.push(item.gap);
  }
  return gaps;
}

/**
 * The prompt asks for null when an item was not found, but a model that writes
 * "not discussed" instead would have its answer read as EVIDENCE, and the gap
 * the clinician needs to see would disappear. This fails the safe way: a whole
 * value that says nothing was found counts as not found.
 *
 * Whole-string only, deliberately. Real evidence can begin with a negative —
 * "No, it shouldn't hurt afterwards" is the clinician answering a question —
 * and must not be swallowed by this.
 */
// An item that does not apply (the sinus, for a lower tooth; pregnancy, where
// it cannot arise) is reported as "Not applicable: <reason>", which is not a
// gap. A bare "N/A" or "Not applicable" gives no reason, and a model that
// writes it for an item that DID apply would hide the gap, so it still counts
// as not found: the clinician dismisses a false line more easily than they
// notice a missing one.
const NEGATIVE = /^[\s"'\-—.]*(null|none|n\/?a|nil|nothing|no evidence|not applicable:?|not (discussed|mentioned|found|said|stated|covered|addressed|raised|in the transcript))[\s"'\-—.]*$/i;

const NO_CONTENT = /^[\s"'\-—.·]*$/;

function isNegative(value) {
  const v = String(value).trim();
  return NO_CONTENT.test(v) || NEGATIVE.test(v);
}
