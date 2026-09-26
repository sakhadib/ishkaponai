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
import { useEffect, useState } from 'react'
import { STUDY_SUBJECTS, type StudySubject } from '@shared/types'
import { SettingsPanel } from '@/features/settings/sections/SettingsPanel'
import { Field } from '@/components/ui'
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

  // Age is a number in settings but a text field here, so it is held as text and
  // committed on blur. Committing on every keystroke would write "1" then "16"
  // then "167" to SQLite as the student types a two-digit number.
  const [age, setAge] = useState(settings.studentAge === null ? '' : String(settings.studentAge))

  useEffect(() => {
    setAge(settings.studentAge === null ? '' : String(settings.studentAge))
  }, [settings.studentAge])

  const commitAge = (): void => {
    const trimmed = age.trim()

    if (trimmed === '') {
      if (settings.studentAge !== null) void update({ studentAge: null })
      return
    }

    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      // Put the field back to what is actually stored rather than leaving an
      // unparseable value sitting in the input looking accepted.
      setAge(settings.studentAge === null ? '' : String(settings.studentAge))
      return
    }

    void update({ studentAge: Math.round(parsed) })
  }

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
          value={settings.studentName}
          placeholder="e.g. Nusrat"
          autoComplete="off"
          onChange={(event) => void update({ studentName: event.target.value })}
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
          value={age}
          placeholder="e.g. 16"
          onChange={(event) => setAge(event.target.value)}
          onBlur={commitAge}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitAge()
            }
          }}
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
          value={settings.studentGrade}
          placeholder="e.g. Class 10, Year 11, O-Level"
          autoComplete="off"
          onChange={(event) => void update({ studentGrade: event.target.value })}
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
