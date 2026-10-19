import { Schema, model, type InferSchemaType } from "mongoose";

// Content for GET /provider/tutorial.
const tutorialSchema = new Schema(
	{
		text: { type: String, required: true },
	},
	{ timestamps: true },
);

export type Tutorial = InferSchemaType<typeof tutorialSchema>;
export const TutorialModel = model("Tutorial", tutorialSchema);
