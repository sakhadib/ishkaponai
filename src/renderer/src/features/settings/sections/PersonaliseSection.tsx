/**
 * Personalise: who the answers are for.
 *
 * The one pane in Settings that is about the student rather than about the app.
 * Everything here is injected into the system prompt on every turn, so the model
 * can pitch at the right level and stay inside the syllabus the student is
 * actually studying.
 *
 * Two deliberate choices:
 *
 *  - **Every field is optional and the pane never blocks.** A student who has
 *    told us nothing still gets a fully working app. Forcing a profile first
 *    would be a wall in front of the one thing they came to do.
 *  - **Nothing is required, and nothing is nagged about.** The copy says what
 *    each field changes, so an empty field reads as a deliberate choice rather
 *    than an oversight.
 */
import { LIMITS, STUDY_SUBJECTS, type StudySubject } from '@shared/types'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { Field } from '@/components/ui'
import { useDraftField } from '@/lib/useDraftField'
import { useSettingsStore } from '@/store/settingsStore'

/** Human labels. The wire value stays lowercase for the prompt. */
const SUBJECT_LABEL: Record<StudySubject, string> = {
  math: 'Mathematics',
  physics: 'Physics',
  chemistry: 'Chemistry'
}

const SUBJECT_BLURB: Record<StudySubject, string> = {
  math: 'Algebra, geometry, calculus, statistics',
  physics: 'Mechanics, waves, electricity, optics',
  chemistry: 'Stoichiometry, bonding, acids and bases, organic'
}

export function PersonaliseSection(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)

  // All three text fields edit locally and commit on blur, because main
  // normalises what it stores and a per-keystroke round trip applies that
  // normalisation to text that is still being typed — which is what made it
  // impossible to type a second word in your own name. See `useDraftField`.
  const name = useDraftField(settings.studentName, (raw) => {
    void update({ studentName: raw })
  })

  const grade = useDraftField(settings.studentGrade, (raw) => {
    void update({ studentGrade: raw })
  })

  // Age is a number in settings but a text field here.
  const age = useDraftField(
    settings.studentAge === null ? '' : String(settings.studentAge),
    (raw) => {
      const trimmed = raw.trim()
      // Blank is a real answer — "not given" — and has to survive as `null`
      // rather than as the empty string the input holds.
      if (trimmed === '') {
        if (settings.studentAge !== null) void update({ studentAge: null })
        return
      }
      const parsed = Number(trimmed)
      // Unparseable: commit nothing and leave the text as typed, so the student
      // can see it and correct it. Resetting the field would read as the app
      // silently rejecting them.
      if (!Number.isFinite(parsed)) return
      void update({ studentAge: Math.round(parsed) })
    }
  )

  const toggleSubject = (subject: StudySubject): void => {
    const next = settings.studySubjects.includes(subject)
      ? settings.studySubjects.filter((s) => s !== subject)
      : [...settings.studySubjects, subject]
    void update({ studySubjects: next })
  }

  return (
    <SettingsPanel
      title="Personalise"
      description="Tell ISHKAPON who it is solving for, and it will pitch at the right level and stick to the subjects you are studying. Everything here stays on this computer."
    >
      <Field
        label="Your name"
        htmlFor="setting-student-name"
        hint="Used only to address you naturally. Answers will not open by saying your name."
      >
        <input
          id="setting-student-name"
          className="field__input"
          type="text"
          value={name.value}
          maxLength={LIMITS.studentNameMaxLength}
          placeholder="e.g. Nusrat Jahan"
          autoComplete="off"
          onChange={(event) => name.onChange(event.target.value)}
          onFocus={name.onFocus}
          onBlur={name.onBlur}
          onKeyDown={name.onKeyDown}
        />
      </Field>

      <Field
        label="Age"
        htmlFor="setting-student-age"
        hint="Helps judge how much to explain. Leave empty if you would rather not say."
      >
        <input
          id="setting-student-age"
          className="field__input"
          type="number"
          min={5}
          max={120}
          step={1}
          value={age.value}
          placeholder="e.g. 16"
          onChange={(event) => age.onChange(event.target.value)}
          onFocus={age.onFocus}
          onBlur={age.onBlur}
          onKeyDown={age.onKeyDown}
        />
      </Field>

      <Field
        label="Class or year"
        htmlFor="setting-student-grade"
        hint="Whatever your school calls it. Used to keep the method inside your syllabus."
      >
        <input
          id="setting-student-grade"
          className="field__input"
          type="text"
          value={grade.value}
          maxLength={LIMITS.studentGradeMaxLength}
          placeholder="e.g. Class 10, Year 11, O-Level"
          autoComplete="off"
          onChange={(event) => grade.onChange(event.target.value)}
          onFocus={grade.onFocus}
          onBlur={grade.onBlur}
          onKeyDown={grade.onKeyDown}
        />
      </Field>

      <fieldset className="subjects">
        <legend className="field__label">Subjects you mainly study</legend>
        <p className="field__hint">
          Pick as many as apply. Questions outside them are still answered — ISHKAPON just will not
          assume the surrounding context.
        </p>

        <div className="subjects__list">
          {STUDY_SUBJECTS.map((subject) => {
            const selected = settings.studySubjects.includes(subject)
            return (
              <label className="subject" key={subject} data-selected={selected}>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleSubject(subject)}
                />
                <span className="subject__text">
                  <span className="subject__name">{SUBJECT_LABEL[subject]}</span>
                  <span className="subject__blurb">{SUBJECT_BLURB[subject]}</span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      {/* Stated rather than assumed: a student should know this is a local
          preference and not a profile being built somewhere else. */}
      {isEmpty(settings) ? (
        <div className="settings__note">
          <p className="settings__note-line">Nothing filled in yet.</p>
          <p className="settings__note-hint">
            ISHKAPON works fine without any of this — it will solve whatever you ask and ask you
            if it needs to know your level. Filling this in only makes the answers fit you better.
          </p>
        </div>
      ) : null}
    </SettingsPanel>
  )
}

function isEmpty(settings: {
  studentName: string
  studentGrade: string
  studentAge: number | null
  studySubjects: readonly StudySubject[]
}): boolean {
  return (
    settings.studentName.trim() === '' &&
    settings.studentGrade.trim() === '' &&
    settings.studentAge === null &&
    settings.studySubjects.length === 0
  )
}
