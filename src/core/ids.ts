import { ObjectId } from "mongodb";
export const newId = (): string => new ObjectId().toHexString();
