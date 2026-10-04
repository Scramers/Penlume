import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import { EditorView, ViewPlugin, lineNumbers } from '@codemirror/view'
import type { Preferences } from '../../shared/preferences'
import { codePairExtension } from './writing-aids'

const hideLineNumbers = EditorView.theme({ '& .cm-gutter.cm-lineNumbers': { display: 'none !important' } })

function configuration(preferences: Preferences): Extension {
  return [EditorState.tabSize.of(preferences.tabSize), indentUnit.of(' '.repeat(preferences.tabSize)), lineNumbers(), preferences.codeWrap ? EditorView.lineWrapping : [],
    // CodeMirror's base .cm-gutter uses display:flex !important to prevent margin
    // collapse. Match that priority and target only this editor's number gutter;
    // removing this rule restores the native display without affecting fold controls.
    preferences.codeLineNumbers ? [] : hideLineNumbers, codePairExtension(preferences)]
}

/** One controller can be shared by all code/math CM views without recreating any view. */
export function createCodePreferences(getPreferences: () => Preferences): { extension: Extension; update: () => void; destroy: () => void } {
  const compartment = new Compartment(), views = new Set<EditorView>()
  let disposed = false
  const updateView = (view: EditorView) => { if (!disposed && views.has(view)) view.dispatch({ effects: compartment.reconfigure(configuration(getPreferences())) }) }
  const extension: Extension = [compartment.of(configuration(getPreferences())), ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { views.add(view); queueMicrotask(() => updateView(view)) }
    destroy() { views.delete(this.view) }
  })]
  return { extension, update: () => { if (!disposed) for (const view of views) updateView(view) }, destroy: () => { disposed = true; views.clear() } }
}
