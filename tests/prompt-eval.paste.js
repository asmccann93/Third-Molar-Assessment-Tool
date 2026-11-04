// tests/prompt-eval.paste.js  — GENERATED, do not edit
// Edit tests/fixtures/transcripts.json or tests/eval-assert.mjs,
// then run: node tests/build-eval.mjs
//
// Assertion logic for the transcript fixtures. Not used directly — run
// `node tests/build-eval.mjs` to produce tests/prompt-eval.paste.js with the
// fixtures inlined, then paste that into the browser console.
//
// Why inlined rather than fetched: the CSP on /ai-notes/ is connect-src 'self',
// so the console cannot pull fixtures from anywhere external. Inlining sidesteps
// it, and means no test files have to be deployed to the live site.

(async function () {
  const FIXTURES = [
  {
    "id": "extraction-thorough",
    "consultType": "extraction-surgery",
    "probes": "Baseline. A properly conducted discussion should fill most fields. If this one produces gaps, the prompt is too strict and every real note will look thin.",
    "turns": [
      {
        "speaker": "S1",
        "text": "Right, so this is the lower left wisdom tooth, the one that's been giving you grief."
      },
      {
        "speaker": "S2",
        "text": "Yeah, it's been on and off for about six months now. Worse the last fortnight."
      },
      {
        "speaker": "S1",
        "text": "And you're otherwise fit and well? Still on the ramipril, nothing else changed?"
      },
      {
        "speaker": "S2",
        "text": "Just the ramipril. No allergies."
      },
      {
        "speaker": "S1",
        "text": "Good. So on the x-ray the roots are sitting close to the nerve that supplies feeling to your lower lip and chin. That's the main thing I need to talk you through."
      },
      {
        "speaker": "S1",
        "text": "There's a risk of numbness or altered sensation to that lip and chin afterwards. Temporary in around one in ten, and permanent in something like one in a hundred."
      },
      {
        "speaker": "S2",
        "text": "Permanent as in forever?"
      },
      {
        "speaker": "S1",
        "text": "Forever, yes. It's uncommon but it does happen and I'd rather you heard it from me now than found out afterwards."
      },
      {
        "speaker": "S1",
        "text": "Beyond that you'd expect swelling and soreness for a few days, some difficulty opening, and there's a risk of infection and of dry socket, which is a painful healing complication."
      },
      {
        "speaker": "S1",
        "text": "Bleeding as well, though that's usually straightforward to manage."
      },
      {
        "speaker": "S2",
        "text": "How long am I off work?"
      },
      {
        "speaker": "S1",
        "text": "Most people take two or three days. If you're doing anything physical, closer to a week."
      },
      {
        "speaker": "S1",
        "text": "Now, the alternatives. We could leave it alone and just manage the flare-ups when they happen, but they're likely to keep coming back and each one is a course of antibiotics."
      },
      {
        "speaker": "S1",
        "text": "There's also an operation called a coronectomy where I take the crown off and deliberately leave the roots behind, which lowers the nerve risk considerably. It's not suitable for every tooth but it would be an option for yours."
      },
      {
        "speaker": "S2",
        "text": "What would you do?"
      },
      {
        "speaker": "S1",
        "text": "I can't make that call for you, but given how often it's flaring I'd be leaning towards dealing with it rather than leaving it."
      },
      {
        "speaker": "S1",
        "text": "Cost-wise, the extraction is three hundred and forty, the coronectomy is three hundred and ninety because it takes longer."
      },
      {
        "speaker": "S2",
        "text": "And if it gets infected afterwards, is that extra?"
      },
      {
        "speaker": "S1",
        "text": "No, reviews and any complication management are included."
      },
      {
        "speaker": "S2",
        "text": "I think I'd rather just have it out and be done with it."
      },
      {
        "speaker": "S1",
        "text": "That's fine. I'll get you booked in, and I'll give you the leaflet on wisdom tooth removal to take home so you can read it all again properly."
      },
      {
        "speaker": "S2",
        "text": "Thanks."
      }
    ],
    "expect": {
      "notNull": [
        "reasonForAttendance",
        "medicalHistory",
        "proposed",
        "alternatives",
        "risks",
        "costs",
        "patientQuestions",
        "decision",
        "nextStep"
      ],
      "mustMention": {
        "risks": [
          "nerve",
          "dry socket",
          "infection"
        ],
        "alternatives": [
          "coronectomy"
        ],
        "costs": [
          "340"
        ],
        "informationGiven": [
          "leaflet"
        ]
      },
      "gapsAtMost": 4
    }
  },
  {
    "id": "extraction-vague",
    "consultType": "extraction-surgery",
    "probes": "THE trap the prompt is built around. The clinician gestures at risks without naming any. 'I explained the risks' is a gap, not a risk list. A model being helpful will fill in the standard extraction risks from its own knowledge — that is the failure mode that makes this tool a liability.",
    "turns": [
      {
        "speaker": "S1",
        "text": "So that's the broken one at the back, upper right. It needs to come out."
      },
      {
        "speaker": "S2",
        "text": "I thought as much."
      },
      {
        "speaker": "S1",
        "text": "Any changes to your health since last time? Still nothing regular?"
      },
      {
        "speaker": "S2",
        "text": "Nothing, no."
      },
      {
        "speaker": "S1",
        "text": "Right. I've gone through all the usual risks with you before for the other one, so you know the score there."
      },
      {
        "speaker": "S2",
        "text": "Yeah, I remember."
      },
      {
        "speaker": "S1",
        "text": "Good. Two hundred and ten for that one. Shall we get you booked?"
      },
      {
        "speaker": "S2",
        "text": "Go on then."
      },
      {
        "speaker": "S1",
        "text": "Reception will sort you a slot."
      }
    ],
    "expect": {
      "mustBeNull": [
        "risks",
        "alternatives"
      ],
      "notNull": [
        "reasonForAttendance",
        "proposed",
        "costs",
        "decision"
      ],
      "gapsMustMatch": [
        "risk",
        "alternativ"
      ],
      "mustNotMentionAnywhere": [
        "dry socket",
        "sinus",
        "nerve",
        "bleeding",
        "infection"
      ]
    }
  },
  {
    "id": "patient-raises-risk",
    "consultType": "extraction-surgery",
    "probes": "Attribution. The patient names a risk; the clinician sidesteps it and never confirms. It belongs in patientQuestions, NOT risks. Getting this wrong records a risk as clinician-named when it was not — the single most damaging error the tool can make, and the one worth checking hardest.",
    "turns": [
      {
        "speaker": "S1",
        "text": "So it's the lower right one today. Straightforward enough on the x-ray."
      },
      {
        "speaker": "S2",
        "text": "My sister had one out and she said her lip was numb for months afterwards. Is that going to happen to me?"
      },
      {
        "speaker": "S1",
        "text": "Everyone's different. Let's have a look at where yours is sitting."
      },
      {
        "speaker": "S2",
        "text": "She said it was really horrible, she couldn't feel her chin properly."
      },
      {
        "speaker": "S1",
        "text": "Mm. Open wide for me. Yes, that's quite mobile already, that should come out easily enough."
      },
      {
        "speaker": "S2",
        "text": "But the numbness thing — should I be worried about that?"
      },
      {
        "speaker": "S1",
        "text": "Let's get you numbed up and have a proper look on the day. I'll do a bit of local anaesthetic and we'll take it from there."
      },
      {
        "speaker": "S1",
        "text": "It'll be a hundred and eighty. Thursday any good?"
      },
      {
        "speaker": "S2",
        "text": "Thursday's fine I suppose."
      }
    ],
    "expect": {
      "mustBeNull": [
        "risks"
      ],
      "notNull": [
        "patientQuestions",
        "reasonForAttendance",
        "proposed"
      ],
      "mustMention": {
        "patientQuestions": [
          "numb"
        ]
      },
      "mustNotMention": {
        "risks": [
          "numb",
          "nerve"
        ]
      },
      "gapsMustMatch": [
        "risk"
      ]
    }
  },
  {
    "id": "nurse-aftercare",
    "consultType": "extraction-surgery",
    "probes": "The one exception to excluding nurse speech. Aftercare given by the nurse goes in informationGiven, attributed to her. Her logistics chatter does not go anywhere.",
    "turns": [
      {
        "speaker": "S1",
        "text": "That's it out, all in one piece. Bite on that gauze for me."
      },
      {
        "speaker": "S1",
        "text": "There was a bit more bleeding than I'd like so I've put a single stitch in. It'll dissolve on its own in about a week."
      },
      {
        "speaker": "S2",
        "text": "Do I need to come back to get it taken out?"
      },
      {
        "speaker": "S1",
        "text": "No, it'll go by itself. But do come back if you get increasing pain around day three or four, because that can be a dry socket."
      },
      {
        "speaker": "S3",
        "text": "So for the rest of today, no rinsing at all, no hot drinks, and try not to spit."
      },
      {
        "speaker": "S3",
        "text": "From tomorrow, warm salty water rinses after meals, four or five times a day. Half a teaspoon of salt in a mug."
      },
      {
        "speaker": "S3",
        "text": "Painkillers, take whatever you'd normally take for a headache, and take them before the numbness wears off rather than waiting."
      },
      {
        "speaker": "S3",
        "text": "No smoking and no alcohol for at least forty-eight hours, and no strenuous exercise today."
      },
      {
        "speaker": "S2",
        "text": "How long till I can eat normally?"
      },
      {
        "speaker": "S3",
        "text": "Soft stuff today, then see how you feel. Chew on the other side while it's sore."
      },
      {
        "speaker": "S3",
        "text": "I'll pop you a review in for a fortnight. Is Tuesday mornings usually all right for you?"
      },
      {
        "speaker": "S2",
        "text": "Tuesday's fine."
      },
      {
        "speaker": "S3",
        "text": "Lovely, I'll get that in the diary and print you the card."
      }
    ],
    "expect": {
      "notNull": [
        "informationGiven",
        "proposed",
        "nextStep"
      ],
      "mustMention": {
        "informationGiven": [
          "salt",
          "nurse"
        ]
      },
      "mustNotMentionAnywhere": [
        "Tuesday mornings usually"
      ]
    }
  },
  {
    "id": "undecided-with-partner",
    "consultType": "treatment-plan",
    "probes": "Two things. Decision is deferred, not made — recording a decision here would be inventing consent. And an accompanying adult's contributions go in patientQuestions marked as coming from them, not merged into the patient's own words.",
    "turns": [
      {
        "speaker": "S1",
        "text": "So there are three ways we could go with the gap. A bridge, an implant, or a denture."
      },
      {
        "speaker": "S1",
        "text": "The bridge means preparing the two teeth either side, which are currently untouched. That's the downside — I'd be cutting into healthy teeth."
      },
      {
        "speaker": "S1",
        "text": "The implant leaves the neighbours alone but it's a longer process, six months or so from start to finish, and it's the most expensive at two thousand four hundred."
      },
      {
        "speaker": "S1",
        "text": "The denture is nine hundred and it's removable, which some people get on with and some really don't."
      },
      {
        "speaker": "S2",
        "text": "And what if I just leave it?"
      },
      {
        "speaker": "S1",
        "text": "That's a perfectly reasonable option too. The teeth either side may drift over time, but plenty of people live with a gap quite happily, especially further back like yours."
      },
      {
        "speaker": "S3",
        "text": "She's been quite self-conscious about it though, haven't you."
      },
      {
        "speaker": "S2",
        "text": "It's not that bad."
      },
      {
        "speaker": "S3",
        "text": "How long does the implant one last? Is it a lifetime thing or does it need redoing?"
      },
      {
        "speaker": "S1",
        "text": "Most last well over ten years, but I'd be misleading you if I said lifetime. Nothing we put in is permanent."
      },
      {
        "speaker": "S2",
        "text": "The bridge is what, sixteen hundred?"
      },
      {
        "speaker": "S1",
        "text": "Sixteen hundred and fifty."
      },
      {
        "speaker": "S2",
        "text": "I think I need to have a think about it, if that's all right."
      },
      {
        "speaker": "S1",
        "text": "Of course. There's no rush at all on this, nothing's going to get worse in the meantime. Take as long as you need."
      },
      {
        "speaker": "S1",
        "text": "I'll write it all down with the costs so you've got it in front of you."
      }
    ],
    "expect": {
      "notNull": [
        "alternatives",
        "costs",
        "decision",
        "patientQuestions",
        "informationGiven"
      ],
      "mustMention": {
        "decision": [
          "think"
        ],
        "alternatives": [
          "leav"
        ],
        "costs": [
          "2400",
          "900"
        ]
      },
      "decisionMustNotMatch": [
        "agreed to",
        "consented to",
        "opted for",
        "decided on"
      ]
    }
  },
  {
    "id": "not-a-consultation",
    "consultType": "exam-recall",
    "probes": "The failsafe. Not a clinical conversation. Everything null and one gap saying why. A model that manufactures a note out of this will manufacture one out of anything.",
    "turns": [
      {
        "speaker": "S1",
        "text": "Did you find us all right? The parking round here is a nightmare."
      },
      {
        "speaker": "S2",
        "text": "I ended up in the Tesco one in the end. Walked from there."
      },
      {
        "speaker": "S1",
        "text": "That's probably the safest bet, honestly. The one behind is permit only now."
      },
      {
        "speaker": "S2",
        "text": "Is it always this cold in here?"
      },
      {
        "speaker": "S1",
        "text": "The heating's been playing up all week. Someone's coming out Thursday supposedly."
      },
      {
        "speaker": "S2",
        "text": "Right."
      },
      {
        "speaker": "S1",
        "text": "Sorry, give me two minutes, I just need to find your notes on here."
      }
    ],
    "expect": {
      "allNull": true,
      "gapsAtLeast": 1
    }
  },
  {
    "id": "materiality-musician",
    "consultType": "extraction-surgery",
    "probes": "patientFactors, which none of the other fixtures reaches, and which is arguably what Montgomery actually turns on. A risk is material because of who this patient is. The patient volunteers that she plays clarinet semi-professionally with an audition coming up; the clinician picks it up and adjusts the discussion around it. That link must survive into patientFactors, not be flattened into a generic risk line. A model that records 'risk of altered sensation discussed' has technically said something true and destroyed the only part that would matter in a complaint.",
    "turns": [
      {
        "speaker": "S1",
        "text": "So it's the lower left wisdom tooth. On the x-ray the roots are sitting right on top of the nerve canal."
      },
      {
        "speaker": "S2",
        "text": "Right."
      },
      {
        "speaker": "S1",
        "text": "That means there's a real risk of numbness or altered feeling in the lower lip and chin afterwards. Temporary in about one in ten, permanent in about one in a hundred."
      },
      {
        "speaker": "S2",
        "text": "When you say altered feeling, what does that actually mean? Because I play clarinet."
      },
      {
        "speaker": "S1",
        "text": "Tell me more about that."
      },
      {
        "speaker": "S2",
        "text": "I'm semi-professional. I've got an audition for a chamber group in about six weeks and I practise two or three hours a day."
      },
      {
        "speaker": "S1",
        "text": "That changes things, and I'm glad you said. Altered sensation can mean tingling, or a dead feeling, or the lip not quite doing what you ask it to."
      },
      {
        "speaker": "S1",
        "text": "For most people that's a nuisance. For an embouchure it could be the difference between playing well and not playing at all, and I can't promise you it would come back."
      },
      {
        "speaker": "S2",
        "text": "So should I not have it done?"
      },
      {
        "speaker": "S1",
        "text": "I'm not saying that. But given the audition, I'd think carefully about the timing, and I'd want you to weigh that nerve risk much more heavily than I'd normally suggest."
      },
      {
        "speaker": "S1",
        "text": "The alternative is a coronectomy. I take the crown off and leave the roots where they are, well away from the nerve. The nerve risk drops a long way."
      },
      {
        "speaker": "S2",
        "text": "Is that as good?"
      },
      {
        "speaker": "S1",
        "text": "It deals with the infections, which is what's actually bothering you. The roots stay put and occasionally need dealing with years later, so it's a trade."
      },
      {
        "speaker": "S2",
        "text": "And I could just leave it until after the audition?"
      },
      {
        "speaker": "S1",
        "text": "You could. The risk is you get another flare-up in the meantime and end up dealing with it at short notice, which is the worst timing of all."
      },
      {
        "speaker": "S2",
        "text": "Can I think about it?"
      },
      {
        "speaker": "S1",
        "text": "Please do. There's no rush this week. I'll write down the three options and the numbers so you've got them."
      }
    ],
    "expect": {
      "notNull": [
        "patientFactors",
        "risks",
        "alternatives",
        "patientQuestions",
        "decision",
        "informationGiven"
      ],
      "mustMention": {
        "patientFactors": [
          "clarinet"
        ],
        "risks": [
          "nerve"
        ],
        "alternatives": [
          "coronectomy"
        ],
        "decision": [
          "think"
        ]
      },
      "decisionMustNotMatch": [
        "agreed to",
        "consented to",
        "opted for"
      ]
    }
  },
  {
    "id": "sedation-discussed-never-given",
    "consultType": "sedation",
    "probes": "Sedation is the subject of the whole conversation and none is given. The sedation RECORD is dictated after a sedation appointment. A record manufactured from a discussion ABOUT sedation would put a technique, an agent and a dose into a patient's notes that nobody gave, on the one appointment type where that is most plausible and most wrong.",
    "turns": [
      {
        "speaker": "S1",
        "text": "So you've been referred over for the two lower wisdom teeth, and the main thing you wanted to talk about was being asleep for it."
      },
      {
        "speaker": "S2",
        "text": "I can't do it awake. I just can't. I had a bad time as a child."
      },
      {
        "speaker": "S1",
        "text": "That's very common and it's not a problem. What we do here is intravenous sedation, which isn't a general anaesthetic — you're awake but very relaxed, and most people remember almost nothing about it."
      },
      {
        "speaker": "S1",
        "text": "It's a drug called midazolam, given through a small cannula in the back of the hand or the arm."
      },
      {
        "speaker": "S2",
        "text": "Will I be out?"
      },
      {
        "speaker": "S1",
        "text": "Not out, no. You'll be able to hear me and do what I ask, but the time passes very quickly and the memory of it is usually patchy or absent altogether."
      },
      {
        "speaker": "S1",
        "text": "The things I have to tell you about it. Most people get a bit of bruising where the cannula goes. You'll be unsteady afterwards, so you must have a responsible adult to take you home and stay with you for the rest of the day."
      },
      {
        "speaker": "S2",
        "text": "My daughter could do that."
      },
      {
        "speaker": "S1",
        "text": "That's fine, as long as she's over eighteen and can stay with you until bedtime. You can't drive, you can't work, and you shouldn't sign anything or look after children on your own for twenty-four hours."
      },
      {
        "speaker": "S1",
        "text": "Nothing to eat for six hours beforehand and only water up to two hours before."
      },
      {
        "speaker": "S2",
        "text": "And what about the actual teeth?"
      },
      {
        "speaker": "S1",
        "text": "Both lower wisdom teeth out, surgically, on the same visit. You'd expect swelling and soreness for a few days, and there's the nerve risk I wrote to your dentist about — numbness of the lip and chin, temporary in about one in ten and permanent in around one in a hundred."
      },
      {
        "speaker": "S2",
        "text": "Right."
      },
      {
        "speaker": "S1",
        "text": "The alternative is doing it awake with just local anaesthetic, which plenty of people manage, or leaving them and treating the flare-ups as they come."
      },
      {
        "speaker": "S2",
        "text": "No. I want the sedation."
      },
      {
        "speaker": "S1",
        "text": "Then we'll book it. Nothing happens today — today was just to talk it through and check you're suitable, which you are."
      },
      {
        "speaker": "S2",
        "text": "How much is it?"
      },
      {
        "speaker": "S1",
        "text": "The sedation is three hundred and twenty pounds on top of the surgical fee, which your dentist will have on the referral."
      },
      {
        "speaker": "S2",
        "text": "Fine."
      },
      {
        "speaker": "S1",
        "text": "Good. Reception will find you a date and send out the pre-sedation instructions in writing."
      }
    ],
    "expect": {
      "notNull": [
        "proposed",
        "risks",
        "decision"
      ],
      "listsMustBeEmpty": [
        "sedation",
        "laLog",
        "implantLog",
        "bpe"
      ],
      "mustMention": {
        "costs": [
          "320"
        ]
      },
      "gapsAtMost": 4
    }
  },
  {
    "id": "lesion-urgent-referral",
    "consultType": "lesion",
    "probes": "A lesion appointment where the assessment IS the appointment. Two failures matter: not recording the diagnosis the clinician actually stated, and escalating the clinician's careful wording into a word they never used. Nobody says cancer, malignancy or carcinoma in this transcript. If any of those reaches the note, the record says the patient was told something they were not.",
    "turns": [
      {
        "speaker": "S1",
        "text": "Thanks for coming in at short notice. Your dentist spotted something on the side of your tongue and wanted a second look."
      },
      {
        "speaker": "S2",
        "text": "It's been there about three weeks. I thought I'd bitten it."
      },
      {
        "speaker": "S1",
        "text": "Has it changed at all?"
      },
      {
        "speaker": "S2",
        "text": "It's not got better. It's not really sore either, that's the odd thing."
      },
      {
        "speaker": "S1",
        "text": "And you smoke, is that right?"
      },
      {
        "speaker": "S2",
        "text": "About fifteen a day. Have done for thirty years."
      },
      {
        "speaker": "S1",
        "text": "Alcohol?"
      },
      {
        "speaker": "S2",
        "text": "Few pints at the weekend."
      },
      {
        "speaker": "S1",
        "text": "Let me have a proper look. Can you put your tongue out and to the right for me."
      },
      {
        "speaker": "S1",
        "text": "Right. So what we've got is an ulcer on the left lateral border of your tongue, about a centimetre across, and the edges of it are firmer than I'd like."
      },
      {
        "speaker": "S2",
        "text": "Is that bad?"
      },
      {
        "speaker": "S1",
        "text": "It's something I'm not prepared to watch. Any ulcer that's been there three weeks and isn't healing needs to be looked at properly by the hospital, and that's what I'm going to arrange."
      },
      {
        "speaker": "S1",
        "text": "I can't tell you what it is from looking at it. They'll almost certainly want to take a small sample of it, and that's the only way to know."
      },
      {
        "speaker": "S2",
        "text": "How long will that take?"
      },
      {
        "speaker": "S1",
        "text": "I'm referring you on the urgent pathway, so you should hear within two weeks. If you haven't heard in two weeks, I want you to ring us."
      },
      {
        "speaker": "S2",
        "text": "Okay."
      },
      {
        "speaker": "S1",
        "text": "I've also had a feel of your neck and I can't feel anything there, which is a good thing."
      },
      {
        "speaker": "S1",
        "text": "I'm not going to pretend this isn't worrying, but the great majority of these turn out to be nothing serious. I'd rather send everybody and be wrong than wait."
      },
      {
        "speaker": "S2",
        "text": "No, I'd rather know."
      },
      {
        "speaker": "S1",
        "text": "I'll do the referral today. Try to cut the cigarettes down in the meantime — that will help whatever this turns out to be."
      }
    ],
    "expect": {
      "notNull": [
        "reasonForAttendance",
        "nextStep"
      ],
      "rowsAtLeast": {
        "diagnoses": 1
      },
      "listMustMention": {
        "diagnoses": [
          "ulcer"
        ]
      },
      "rowSourcesMustBe": {
        "diagnoses": [
          "discussed"
        ]
      },
      "listsMustBeEmpty": [
        "laLog",
        "sedation",
        "implantLog"
      ],
      "mustNotMentionAnywhere": [
        "cancer",
        "malignan",
        "carcinoma",
        "biopsy result",
        "two-week wait rule"
      ],
      "listMustNotMention": {
        "diagnoses": [
          "cancer",
          "malignan",
          "carcinoma",
          "squamous"
        ]
      },
      "mustMention": {
        "nextStep": [
          "refer"
        ]
      }
    }
  },
  {
    "id": "denture-options-and-money",
    "consultType": "denture-consult",
    "probes": "Three options and two prices. The prices must land in costs. On 30 October a real consultation came back with the prices written into informationGiven and 'Costs discussed: Not captured' above them, which reads as a consent failure that did not happen. This is that defect, as a fixture.",
    "turns": [
      {
        "speaker": "S1",
        "text": "So you've lost the upper left six and the four, and you're finding it hard to chew on that side."
      },
      {
        "speaker": "S2",
        "text": "I'm eating on one side. It's getting on my nerves."
      },
      {
        "speaker": "S1",
        "text": "There are three ways we can go about this and they're quite different, so let me take you through all of them."
      },
      {
        "speaker": "S1",
        "text": "The simplest is an acrylic denture. That's the plastic one. It's quick, it's the cheapest, and it covers more of the roof of your mouth, which some people never get used to."
      },
      {
        "speaker": "S1",
        "text": "The second is a cobalt chrome denture. Metal framework, much thinner, clips onto your own teeth, far less coverage of the palate. Most people find it a lot more comfortable and they last longer."
      },
      {
        "speaker": "S2",
        "text": "And the expensive one?"
      },
      {
        "speaker": "S1",
        "text": "Implants. Two implants on that side and a fixed bridge on top, so nothing comes in and out at all. It's the closest thing to having your own teeth back."
      },
      {
        "speaker": "S2",
        "text": "Go on then, what are we talking about?"
      },
      {
        "speaker": "S1",
        "text": "The acrylic is four hundred and fifty pounds. The chrome is eight hundred and ninety."
      },
      {
        "speaker": "S2",
        "text": "And the implants?"
      },
      {
        "speaker": "S1",
        "text": "I'd need to take a scan before I could give you a proper figure for that, so I'm not going to quote you a number today and then change it."
      },
      {
        "speaker": "S2",
        "text": "Fair enough."
      },
      {
        "speaker": "S1",
        "text": "With any denture there's an adjustment period. They feel bulky, your speech can be odd for a week or two, and you may get sore spots that need easing — that's normal and it's why I see you back."
      },
      {
        "speaker": "S1",
        "text": "And a denture that clips onto your own teeth does put some load on them, so we need to keep those teeth very clean."
      },
      {
        "speaker": "S2",
        "text": "I think the chrome one. My sister's got the plastic and she hates it."
      },
      {
        "speaker": "S1",
        "text": "I think that's a sensible choice. We'd start with impressions next time."
      },
      {
        "speaker": "S2",
        "text": "How many visits?"
      },
      {
        "speaker": "S1",
        "text": "Usually four or five, spaced about two weeks apart."
      }
    ],
    "expect": {
      "notNull": [
        "proposed",
        "costs",
        "decision"
      ],
      "rowsAtLeast": {
        "optionsOffered": 2
      },
      "listMustMention": {
        "optionsOffered": [
          "chrome"
        ]
      },
      "listsMustBeEmpty": [
        "laLog",
        "sedation",
        "implantLog",
        "bpe"
      ],
      "mustMention": {
        "costs": [
          "450",
          "890"
        ]
      },
      "mustNotMention": {
        "informationGiven": [
          "450",
          "890"
        ]
      },
      "mustNotMentionAnywhere": [
        "£2,000",
        "2000 for the implants"
      ]
    }
  },
  {
    "id": "emergency-swelling",
    "consultType": "emergency",
    "probes": "An emergency attendance. This is the appointment type where a manufactured sedation record is most plausible and most dangerous: sedation here would require pre-assessment that has not happened. Nothing is dictated, so every structured record must come back empty.",
    "turns": [
      {
        "speaker": "S1",
        "text": "Right, when did this start?"
      },
      {
        "speaker": "S2",
        "text": "It blew up overnight. I couldn't sleep with it."
      },
      {
        "speaker": "S1",
        "text": "Can you open for me? ... How wide can you normally get?"
      },
      {
        "speaker": "S2",
        "text": "A lot more than that."
      },
      {
        "speaker": "S1",
        "text": "Any trouble swallowing? Any difficulty with your breathing?"
      },
      {
        "speaker": "S2",
        "text": "No, nothing like that. Just the pain and the face."
      },
      {
        "speaker": "S1",
        "text": "Good, that's what I needed to know. So you've got an infection from the lower right six, and it's tracked into the soft tissue, which is why the side of your face is up."
      },
      {
        "speaker": "S2",
        "text": "Can you just take it out?"
      },
      {
        "speaker": "S1",
        "text": "Not today, and I'll tell you why. The tissue is too inflamed for the anaesthetic to work properly, and taking it out now would hurt and might not work. What I want to do today is let the pus out, which is what will actually make you feel better."
      },
      {
        "speaker": "S1",
        "text": "So I'll numb it as best I can, make a small cut, drain it, and give you a course of antibiotics."
      },
      {
        "speaker": "S2",
        "text": "And then?"
      },
      {
        "speaker": "S1",
        "text": "Back in a week and we take the tooth out properly, with it settled down."
      },
      {
        "speaker": "S1",
        "text": "Amoxicillin, five hundred milligrams, three times a day for five days. Take them all even if you feel better after two."
      },
      {
        "speaker": "S2",
        "text": "I'm not allergic to anything."
      },
      {
        "speaker": "S1",
        "text": "Good. Hot salty mouthwashes every couple of hours, and paracetamol and ibuprofen together if you can take both."
      },
      {
        "speaker": "S1",
        "text": "The thing I need you to listen to: if the swelling starts going under your jaw or towards your eye, if you can't swallow your own spit, or if you can't open at all, you don't wait for me — you go to A&E."
      },
      {
        "speaker": "S2",
        "text": "Understood."
      }
    ],
    "expect": {
      "notNull": [
        "proposed",
        "informationGiven"
      ],
      "listsMustBeEmpty": [
        "sedation",
        "laLog",
        "implantLog",
        "bpe"
      ],
      "mustMention": {
        "informationGiven": [
          "a&e"
        ]
      },
      "mustNotMentionAnywhere": [
        "intravenous sedation",
        "midazolam"
      ]
    }
  },
  {
    "id": "perio-bpe-called-aloud",
    "consultType": "perio",
    "probes": "The clinician calls the six sextant scores aloud. The BPE must be taken from what was said, in the right sextants. Paired with perio-bpe-not-stated: a model that invents a chart passes this fixture and fails that one.",
    "turns": [
      {
        "speaker": "S1",
        "text": "I'm going to go round with the probe and call the scores out as I go. Upper right, two."
      },
      {
        "speaker": "S1",
        "text": "Upper anterior, one."
      },
      {
        "speaker": "S1",
        "text": "Upper left, two."
      },
      {
        "speaker": "S1",
        "text": "Lower right, three."
      },
      {
        "speaker": "S1",
        "text": "Lower anterior, one."
      },
      {
        "speaker": "S1",
        "text": "Lower left, four."
      },
      {
        "speaker": "S2",
        "text": "Is four bad?"
      },
      {
        "speaker": "S1",
        "text": "Four means there's a deeper pocket there, so that's the corner we need to concentrate on. It's not a disaster but it does need treating."
      },
      {
        "speaker": "S1",
        "text": "The bleeding you've noticed is the gum telling you there's plaque sitting below the gumline where the brush isn't reaching."
      },
      {
        "speaker": "S1",
        "text": "What I'd do is clean under the gum properly on that lower left, under local anaesthetic, and go over your brushing and the interdental brushes."
      },
      {
        "speaker": "S2",
        "text": "I do brush twice a day."
      },
      {
        "speaker": "S1",
        "text": "I believe you, and brushing alone doesn't reach between the teeth, which is where this is. The brushes are the thing that will change it."
      },
      {
        "speaker": "S1",
        "text": "If we don't get on top of it the pockets get deeper and eventually the teeth loosen. If we do, it stabilises and most people keep everything."
      },
      {
        "speaker": "S2",
        "text": "How much?"
      },
      {
        "speaker": "S1",
        "text": "It's within your NHS course, so there's no extra charge for it."
      },
      {
        "speaker": "S2",
        "text": "Let's do it."
      },
      {
        "speaker": "S1",
        "text": "I'll book you a longer appointment and we'll re-measure in three months."
      }
    ],
    "expect": {
      "rowsAtLeast": {
        "bpe": 1
      },
      "listMustMention": {
        "bpe": [
          "4"
        ]
      },
      "listsMustBeEmpty": [
        "laLog",
        "sedation",
        "implantLog"
      ],
      "notNull": [
        "proposed"
      ]
    }
  },
  {
    "id": "perio-bpe-not-stated",
    "consultType": "perio",
    "probes": "The pair to perio-bpe-called-aloud. The same kind of appointment with no scores spoken. A BPE here is a chart nobody recorded, in a patient's periodontal notes, and it is exactly what a helpful model produces.",
    "turns": [
      {
        "speaker": "S1",
        "text": "Your gums are bleeding in a few places when I touch them, particularly round the back on the lower left."
      },
      {
        "speaker": "S2",
        "text": "They bleed when I brush too."
      },
      {
        "speaker": "S1",
        "text": "That's the same thing. Healthy gum doesn't bleed."
      },
      {
        "speaker": "S1",
        "text": "There's a fair bit of plaque sitting right at the gumline, and some hard deposit behind the lower front teeth."
      },
      {
        "speaker": "S1",
        "text": "I'd like to clean it all properly and show you how to use interdental brushes, because that's the bit that will actually change it."
      },
      {
        "speaker": "S2",
        "text": "I've never got on with floss."
      },
      {
        "speaker": "S1",
        "text": "Then don't use floss. The little brushes are better anyway and most people find them easier."
      },
      {
        "speaker": "S1",
        "text": "If we leave it, bleeding gums become receding gums and then loose teeth, but we're a long way from that."
      },
      {
        "speaker": "S2",
        "text": "Right, let's sort it."
      },
      {
        "speaker": "S1",
        "text": "I'll do the cleaning today and see you back in three months to see how the bleeding has responded."
      }
    ],
    "expect": {
      "listsMustBeEmpty": [
        "bpe",
        "laLog",
        "sedation",
        "implantLog"
      ],
      "notNull": [
        "proposed"
      ]
    }
  },
  {
    "id": "post-op-review-no-consent",
    "consultType": "post-op",
    "probes": "A review after surgery. There is no procedure being weighed, so proposed, alternatives, risks, benefits, costs, patient factors and a decision do not apply — the server's type table says so and the page leaves them blank rather than claiming they are missing. A model that fills them has invented a consent discussion that did not happen.",
    "turns": [
      {
        "speaker": "S1",
        "text": "So how has the week been?"
      },
      {
        "speaker": "S2",
        "text": "First two days were rough. Fine since Wednesday."
      },
      {
        "speaker": "S1",
        "text": "That's about right. Any numbness of the lip or the chin?"
      },
      {
        "speaker": "S2",
        "text": "No, nothing like that."
      },
      {
        "speaker": "S1",
        "text": "Good, that's the main thing I was watching for. Any bad taste, any swelling coming back?"
      },
      {
        "speaker": "S2",
        "text": "It was swollen for three days and then it went down."
      },
      {
        "speaker": "S1",
        "text": "Let me have a look. ... That's healing very nicely. The socket's closing over, there's no sign of infection and the stitches have mostly gone on their own."
      },
      {
        "speaker": "S2",
        "text": "There's still a bit of a hole."
      },
      {
        "speaker": "S1",
        "text": "There will be for a few weeks yet. It fills in from the bottom up. Keep rinsing with warm salty water after meals and it'll look after itself."
      },
      {
        "speaker": "S2",
        "text": "Can I eat normally?"
      },
      {
        "speaker": "S1",
        "text": "Yes, whatever you fancy now. Just try not to pack food into it."
      },
      {
        "speaker": "S1",
        "text": "I'm happy with that. I don't need to see you again for this — go back to your own dentist for your routine check."
      },
      {
        "speaker": "S2",
        "text": "Thanks very much."
      }
    ],
    "expect": {
      "notNull": [
        "reasonForAttendance"
      ],
      "notApplicableMustInclude": [
        "risks",
        "decision",
        "costs",
        "alternatives"
      ],
      "listsMustBeEmpty": [
        "laLog",
        "sedation",
        "implantLog",
        "optionsOffered",
        "bpe"
      ],
      "mustNotMentionAnywhere": [
        "consent",
        "agreed to proceed"
      ],
      "gapsAtMost": 3
    }
  }
];

  /* assess() is inlined here from tests/eval-assert.mjs at build time. It is
     NOT written out twice any more: the self-tests in build-eval.mjs import
     that module and then check that this inlined copy gives the same answers,
     so the logic the self-tests exercise is the logic that runs against the
     model. */
  function assess(note, expect) {
    const KEYS = [
      'reasonForAttendance', 'medicalHistory', 'proposed', 'alternatives',
      'risks', 'benefits', 'costs', 'patientQuestions', 'patientFactors',
      'informationGiven', 'decision', 'nextStep'
    ];
    const norm = (v) => (v == null ? '' : String(v)).toLowerCase();
    const whole = (n) => KEYS.map((k) => norm(n[k])).join(' \n ');
  
    /* ---- the structured records ----
       laLog, sedation, implantLog, diagnoses, planItems, optionsOffered, bpe and
       radiographs. Until 4 November 2026 the fixtures could say nothing about any
       of them, so the half of the output that carries doses, lot numbers and a
       diagnosis per tooth had no evidence behind it at all. */
  
    // A list as rows. An object record (sedation, bpe, radiographs) is one row.
    const rowsOf = (n, key) => {
      const v = n && n[key];
      if (Array.isArray(v)) return v.filter((r) => r && typeof r === 'object');
      if (v && typeof v === 'object') return [v];
      return [];
    };
  
    /* Empty means "the model recorded nothing here", which is what a record with
       nothing said about it must look like. quotes and named are bookkeeping, not
       content, so a record carrying only those is still empty. */
    const isEmpty = (n, key) => {
      const v = n && n[key];
      if (v == null) return true;
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === 'object') {
        return !Object.keys(v).some((k) => {
          if (k === 'quotes' || k === 'named' || k === 'source') return false;
          const val = v[k];
          if (Array.isArray(val)) return val.length > 0;
          return val != null && String(val).trim() !== '';
        });
      }
      return String(v).trim() === '';
    };
  
    /* The VALUES in a record, never its keys and never its quotes. Matching keys
       would let `listMustMention: { laLog: ['agent'] }` pass on an empty row, and
       matching quotes would let a mention test be satisfied by the patient's own
       words rather than by what the model recorded. */
    const textOf = (n, key) => {
      const out = [];
      const walk = (v, k) => {
        // Bookkeeping, not content — the same two isEmpty ignores.
        if (k === 'quotes' || k === 'named') return;
        if (v == null) return;
        if (Array.isArray(v)) { for (const x of v) walk(x, k); return; }
        if (typeof v === 'object') { for (const kk of Object.keys(v)) walk(v[kk], kk); return; }
        out.push(String(v));
      };
      walk(rowsOf(n, key), key);
      return out.join(' \n ').toLowerCase();
    };
  
    const bad = [];
  
    if (expect.allNull) {
      const filled = KEYS.filter((k) => note[k] != null && String(note[k]).trim() !== '');
      if (filled.length) bad.push(`invented content in: ${filled.join(', ')}`);
    }
  
    for (const k of expect.notNull || []) {
      if (note[k] == null || String(note[k]).trim() === '') bad.push(`${k} is empty but should be filled`);
    }
  
    for (const k of expect.mustBeNull || []) {
      if (note[k] != null && String(note[k]).trim() !== '') {
        bad.push(`${k} should be a gap, got: "${String(note[k]).slice(0, 70)}"`);
      }
    }
  
    // Checklist findings arrive separately from model gaps and mean the
    // opposite thing: "you did not say this", not "I could not find it".
    const notSaid = (note.notSaid || []).map(norm).join(' \n ');
    for (const n of expect.notSaidMustMatch || []) {
      if (!notSaid.includes(n.toLowerCase())) bad.push(`nothing in notSaid mentions "${n}"`);
    }
    for (const n of expect.notSaidMustNotMatch || []) {
      if (notSaid.includes(n.toLowerCase())) bad.push(`notSaid wrongly flags "${n}" as unsaid`);
    }
    if (expect.checklistMustApply && (note.notSaid || []).some((t) => /could not be applied/i.test(t))) {
      bad.push('the model did not report against the checklist at all');
    }
  
    for (const field of Object.keys(expect.mustMention || {})) {
      for (const n of expect.mustMention[field]) {
        if (!norm(note[field]).includes(n.toLowerCase())) bad.push(`${field} does not mention "${n}"`);
      }
    }
  
    for (const field of Object.keys(expect.mustNotMention || {})) {
      for (const n of expect.mustNotMention[field]) {
        if (norm(note[field]).includes(n.toLowerCase())) {
          bad.push(`${field} mentions "${n}" — that was not clinician-named`);
        }
      }
    }
  
    for (const n of expect.mustNotMentionAnywhere || []) {
      if (whole(note).includes(n.toLowerCase())) bad.push(`note contains "${n}" — nobody said it`);
    }
  
    const gaps = (note.gaps || []).map(norm).join(' \n ');
    for (const n of expect.gapsMustMatch || []) {
      if (!gaps.includes(n.toLowerCase())) bad.push(`no gap mentions "${n}"`);
    }
    for (const n of expect.decisionMustNotMatch || []) {
      if (norm(note.decision).includes(n.toLowerCase())) {
        bad.push(`decision claims "${n}" but none was made`);
      }
    }
  
    const g = (note.gaps || []).length;
    if (expect.gapsAtMost != null && g > expect.gapsAtMost) bad.push(`${g} gaps, expected at most ${expect.gapsAtMost}`);
    if (expect.gapsAtLeast != null && g < expect.gapsAtLeast) bad.push(`${g} gaps, expected at least ${expect.gapsAtLeast}`);
  
    /* ---- assertions about the structured records (4 November 2026) ---- */
  
    // The never-invent premise, for the half of the output that is not prose. A
    // consultation where no local anaesthetic was given must come back with an
    // EMPTY la log, not a plausible one.
    for (const key of expect.listsMustBeEmpty || []) {
      if (!isEmpty(note, key)) bad.push(`${key} should be empty, got ${JSON.stringify(note[key]).slice(0, 90)}`);
    }
  
    for (const key of Object.keys(expect.rowsAtLeast || {})) {
      const n = rowsOf(note, key).length;
      if (n < expect.rowsAtLeast[key]) bad.push(`${key} has ${n} rows, expected at least ${expect.rowsAtLeast[key]}`);
    }
    for (const key of Object.keys(expect.rowsAtMost || {})) {
      const n = rowsOf(note, key).length;
      if (n > expect.rowsAtMost[key]) bad.push(`${key} has ${n} rows, expected at most ${expect.rowsAtMost[key]}`);
    }
  
    for (const key of Object.keys(expect.listMustMention || {})) {
      for (const n of expect.listMustMention[key]) {
        if (!textOf(note, key).includes(n.toLowerCase())) bad.push(`${key} does not record "${n}"`);
      }
    }
    for (const key of Object.keys(expect.listMustNotMention || {})) {
      for (const n of expect.listMustNotMention[key]) {
        if (textOf(note, key).includes(n.toLowerCase())) bad.push(`${key} records "${n}" — nobody said it`);
      }
    }
  
    /* Every row in a list must say it came from somewhere we expect. A diagnosis
       the clinician dictated after the patient left must not be marked as
       discussed with them: that is a claim about the consultation, and the page
       shows it as one. */
    for (const key of Object.keys(expect.rowSourcesMustBe || {})) {
      const allowed = expect.rowSourcesMustBe[key];
      for (const row of rowsOf(note, key)) {
        const s = row.source == null || row.source === '' ? 'none' : String(row.source);
        if (!allowed.includes(s)) bad.push(`${key} has a row marked "${s}", expected one of ${allowed.join(' / ')}`);
      }
    }
  
    // The type table: which fields this kind of appointment does not have, so the
    // page can leave them blank rather than claiming they are missing.
    const na = Array.isArray(note.notApplicable) ? note.notApplicable : [];
    for (const k of expect.notApplicableMustInclude || []) {
      if (!na.includes(k)) bad.push(`notApplicable does not include ${k}`);
    }
    for (const k of expect.notApplicableMustNotInclude || []) {
      if (na.includes(k)) bad.push(`notApplicable wrongly includes ${k}`);
    }
  
    return bad;
  }

  const results = [];
  console.log(`\nRunning ${FIXTURES.length} fixtures against /api/extract\n`);

  for (const fx of FIXTURES) {
    process_start: {
      let note;
      try {
        const r = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turns: fx.turns, consultType: fx.consultType })
        });
        const data = await r.json();
        if (!r.ok) {
          console.log(`%c✗ ${fx.id}`, 'color:#a3241c;font-weight:600', `HTTP ${r.status} — ${data.detail || data.error}`);
          results.push({ id: fx.id, failures: [`request failed: ${data.error}`] });
          break process_start;
        }
        note = data.note;
      } catch (e) {
        console.log(`%c✗ ${fx.id}`, 'color:#a3241c;font-weight:600', String(e.message));
        results.push({ id: fx.id, failures: [String(e.message)] });
        break process_start;
      }

      const failures = assess(note, fx.expect);
      results.push({ id: fx.id, failures, note });

      if (failures.length === 0) {
        console.log(`%c✓ ${fx.id}`, 'color:#1f6f3f;font-weight:600');
      } else {
        console.groupCollapsed(`%c✗ ${fx.id}  (${failures.length})`, 'color:#a3241c;font-weight:600');
        for (const f of failures) console.log('   ' + f);
        console.log('%cprobes:', 'color:#666', fx.probes);
        console.log('note:', note);
        console.groupEnd();
      }
    }
  }

  const failed = results.filter((r) => r.failures.length);
  console.log(
    `\n%c${results.length - failed.length}/${results.length} fixtures passed`,
    failed.length ? 'color:#a3241c;font-weight:700' : 'color:#1f6f3f;font-weight:700'
  );
  if (failed.length) console.log('failing:', failed.map((f) => f.id).join(', '));
  window.__evalResults = results;
  console.log('%cfull results in window.__evalResults', 'color:#666');
})();
