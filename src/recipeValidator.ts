import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import recipeSchema from "../contracts/recipe.v1.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const validate = ajv.compile(recipeSchema);

export type RecipeValidationError = {
	path: string;
	message: string;
	kind: "schema" | "semantic" | "insufficient";
};

export type RecipeValidationResult =
	| { valid: true }
	| { valid: false; errors: RecipeValidationError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semanticErrors(recipe: Record<string, unknown>): RecipeValidationError[] {
	const errors: RecipeValidationError[] = [];
	const missingInformation = new Set(
		recipe.missing_information as string[],
	);
	const addError = (
		path: string,
		message: string,
		kind: RecipeValidationError["kind"] = "semantic",
	) => errors.push({ path, message, kind });
	const requireMissingInformation = (
		field: string,
		provenance: unknown,
	): void => {
		if (
			isRecord(provenance) &&
			provenance.kind === "not_specified" &&
			!missingInformation.has(field)
		) {
			addError(
				"/missing_information",
				`Missing information must include "${field}".`,
			);
		}
	};

	const title = recipe.title;
	if (isRecord(title) && (typeof title.value !== "string" || !title.value.trim())) {
		addError("/title/value", "A usable recipe title could not be determined.", "insufficient");
	}
	if (isRecord(title)) requireMissingInformation("title", title.provenance);
	if (isRecord(recipe.description)) {
		requireMissingInformation("description", recipe.description.provenance);
	}

	const ingredients = recipe.ingredients as Array<Record<string, unknown>>;
	const ingredientIds = new Set<string>();
	for (const [index, ingredient] of ingredients.entries()) {
		const path = `/ingredients/${index}`;
		const id = ingredient.id as string;
		const ingredientProvenance = ingredient.provenance as Record<
			string,
			unknown
		>;
		if (ingredientIds.has(id)) {
			addError(`${path}/id`, "Ingredient identifiers must be unique.");
		}
		ingredientIds.add(id);

		if (typeof ingredient.name !== "string" || !ingredient.name.trim()) {
			addError(`${path}/name`, "Ingredient names must not be blank.");
		}

		const quantity = ingredient.quantity as Record<string, unknown>;
		const provenance = quantity.provenance as Record<string, unknown>;
		requireMissingInformation(`ingredients[${index}].quantity`, provenance);
		if (provenance.kind === "estimated") {
			addError(
				`${path}/quantity/provenance/kind`,
				"Ingredient quantities must not be invented.",
			);
		}
		if (
			typeof quantity.amount_text === "string" &&
			!quantity.amount_text.trim()
		) {
			addError(`${path}/quantity/amount_text`, "Quantity text must not be blank.");
		}
		if (typeof quantity.unit === "string" && !quantity.unit.trim()) {
			addError(`${path}/quantity/unit`, "Quantity units must not be blank.");
		}
		if (
			typeof quantity.amount === "number" &&
			typeof quantity.amount_text !== "string" &&
			typeof quantity.unit !== "string"
		) {
			addError(
				`${path}/quantity`,
				"A numeric quantity must include a textual amount or unit.",
			);
		}
		if (ingredientProvenance.kind === "estimated") {
			addError(
				`${path}/provenance/kind`,
				"Ingredient identities must not be invented.",
			);
		}
		checkEvidence(provenance, `${path}/quantity/provenance`, addError);
		checkEvidence(
			ingredientProvenance,
			`${path}/provenance`,
			addError,
		);

		if (!Array.isArray(ingredient.preparation_notes)) continue;
		for (const [noteIndex, note] of ingredient.preparation_notes.entries()) {
			if (isRecord(note) && note.provenance && isRecord(note.provenance)) {
				checkEvidence(
					note.provenance,
					`${path}/preparation_notes/${noteIndex}/provenance`,
					addError,
				);
			}
		}
	}

	const instructions = recipe.instructions as Array<Record<string, unknown>>;
	for (const [index, instruction] of instructions.entries()) {
		const path = `/instructions/${index}`;
		if (instruction.step !== index + 1) {
			addError(`${path}/step`, "Instruction steps must be sequential starting at 1.");
		}
		if (typeof instruction.text !== "string" || !instruction.text.trim()) {
			addError(`${path}/text`, "Instruction text must not be blank.");
		}
		const instructionProvenance = instruction.provenance as Record<
			string,
			unknown
		>;
		const duration = instruction.duration as Record<string, unknown>;
		const durationProvenance = duration.provenance as Record<string, unknown>;
		requireMissingInformation(`instructions[${index}].duration`, durationProvenance);
		if (instructionProvenance.kind === "estimated") {
			addError(`${path}/provenance/kind`, "Instructions must not be invented.");
		}
		if (durationProvenance.kind === "estimated") {
			addError(
				`${path}/duration/provenance/kind`,
				"Instruction durations must not be invented.",
			);
		}

		if (Array.isArray(instruction.ingredient_ids)) {
			for (const [referenceIndex, reference] of instruction.ingredient_ids.entries()) {
				if (typeof reference === "string" && !ingredientIds.has(reference)) {
					addError(
						`${path}/ingredient_ids/${referenceIndex}`,
						"Instruction references an unknown ingredient.",
					);
				}
			}
		}
		checkEvidence(
			instructionProvenance,
			`${path}/provenance`,
			addError,
		);
		checkEvidence(
			durationProvenance,
			`${path}/duration/provenance`,
			addError,
		);
	}

	for (const field of ["servings", "prep_time", "cook_time", "total_time"] as const) {
		const value = recipe[field];
		if (!isRecord(value)) continue;
		const provenance = value.provenance;
		if (isRecord(provenance)) {
			requireMissingInformation(field, provenance);
			if (provenance.kind === "estimated") {
				addError(`/${field}/provenance/kind`, "Missing values must not be invented.");
			}
			checkEvidence(provenance, `/${field}/provenance`, addError);
		}
	}

	const source = recipe.source;
	if (isRecord(source)) {
		for (const field of ["video_title", "creator"] as const) {
			const value = source[field];
			if (isRecord(value) && isRecord(value.provenance)) {
				requireMissingInformation(`source.${field}`, value.provenance);
				checkEvidence(value.provenance, `/source/${field}/provenance`, addError);
			}
		}
	}

	return errors;
}

function checkEvidence(
	provenance: Record<string, unknown>,
	path: string,
	addError: (
		path: string,
		message: string,
		kind?: RecipeValidationError["kind"],
	) => void,
): void {
	if (!Array.isArray(provenance.evidence)) return;
	for (const [index, evidence] of provenance.evidence.entries()) {
		if (!isRecord(evidence)) continue;
		if (
			typeof evidence.start_seconds === "number" &&
			typeof evidence.end_seconds === "number" &&
			evidence.end_seconds < evidence.start_seconds
		) {
			addError(
				`${path}/evidence/${index}`,
				"Evidence end time must be after its start time.",
			);
		}
	}
}

export function validateRecipe(value: unknown): RecipeValidationResult {
	if (!validate(value)) {
		return {
			valid: false,
			errors: (validate.errors ?? []).map((error) => ({
				path: error.instancePath,
				message: error.message ?? "Value does not match the recipe schema.",
				kind: "schema",
			})),
		};
	}

	const errors = semanticErrors(value as Record<string, unknown>);
	return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
