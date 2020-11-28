import {OmoEvent} from "./omoEvent";
import {ProcessDefinition} from "../o-processes/processManifest";
import {OmoEventTypes} from "./eventTypes";
import {ProcessContext} from "../o-processes/interfaces/processContext";

export class RunProcess implements OmoEvent {
    type: OmoEventTypes = "shell.runProcess";

    readonly definition: ProcessDefinition;
    readonly contextModifier?:(processContext:ProcessContext)=>ProcessContext;

    constructor(definition: ProcessDefinition, contextModifier?:(processContext:ProcessContext)=>ProcessContext)
    {
        this.definition = definition;
        this.contextModifier = contextModifier;
    }
}
