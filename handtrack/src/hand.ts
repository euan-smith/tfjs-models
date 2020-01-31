import * as tfconv from '@tensorflow/tfjs-converter';
import * as tf from '@tensorflow/tfjs-core';
import {Box} from './box';

export class HandDetectModel {
  private model: tfconv.GraphModel;
  private anchors: tf.Tensor;
  private input_size: tf.Tensor;
  private iou_threshold: number;
  private scoreThreshold: number;

  constructor(
      model: tfconv.GraphModel, width: number, height: number, ANCHORS: any) {
    this.model = model;
    this.anchors = this._generate_anchors(ANCHORS);
    this.input_size = tf.tensor([width, height]);

    this.iou_threshold = 0.3;
    this.scoreThreshold = 0.5;
  }

  _generate_anchors(ANCHORS: any) {
    const anchors = [];

    for (let i = 0; i < ANCHORS.length; ++i) {
      const anchor = ANCHORS[i];
      anchors.push([anchor.x_center, anchor.y_center]);
    }
    return tf.tensor(anchors);
  }

  _decode_bounds(box_outputs: tf.Tensor) {
    const box_starts = tf.slice(box_outputs, [0, 0], [-1, 2]);
    const centers = tf.add(tf.div(box_starts, this.input_size), this.anchors);
    const box_sizes = tf.slice(box_outputs, [0, 2], [-1, 2]);

    const box_sizes_norm = tf.div(box_sizes, this.input_size);
    const centers_norm = centers;

    const starts = tf.sub(centers_norm, tf.div(box_sizes_norm, 2));
    const ends = tf.add(centers_norm, tf.div(box_sizes_norm, 2));

    return tf.concat2d(
        [
          tf.mul(starts as tf.Tensor2D, this.input_size as tf.Tensor2D) as
              tf.Tensor2D,
          tf.mul(ends, this.input_size) as tf.Tensor2D
        ],
        1);
  }

  _decode_landmarks(raw_landmarks: tf.Tensor) {
    const relative_landmarks = tf.add(
        tf.div(raw_landmarks.reshape([-1, 7, 2]), this.input_size),
        this.anchors.reshape([-1, 1, 2]));

    return tf.mul(relative_landmarks, this.input_size);
  }

  _getBoundingBox(input_image: tf.Tensor) {
    return tf.tidy(() => {
      const img = tf.mul(tf.sub(input_image, 0.5), 2);  // make input [-1, 1]

      const detect_outputs = this.model.predict(img) as tf.Tensor;

      const scores = tf.sigmoid(tf.slice(detect_outputs, [0, 0, 0], [1, -1, 1]))
                         .squeeze() as tf.Tensor1D;

      const raw_boxes =
          tf.slice(detect_outputs, [0, 0, 1], [1, -1, 4]).squeeze();
      const raw_landmarks =
          tf.slice(detect_outputs, [0, 0, 5], [1, -1, 14]).squeeze();
      const boxes = this._decode_bounds(raw_boxes);

      const box_indices =
          tf.image
              .nonMaxSuppression(
                  boxes, scores, 1, this.iou_threshold, this.scoreThreshold)
              .arraySync();

      const landmarks = this._decode_landmarks(raw_landmarks);
      if (box_indices.length == 0) {
        return [null, null];  // TODO (vakunov): don't return null. Empty box?
      }

      // TODO (vakunov): change to multi hand case
      const box_index = box_indices[0];
      const result_box = tf.slice(boxes, [box_index, 0], [1, -1]);

      const result_landmarks =
          tf.slice(landmarks, [box_index, 0], [1]).reshape([-1, 2]);
      return [result_box, result_landmarks];
    });
  }

  getSingleBoundingBox(input_image: tf.Tensor4D) {
    const original_h = input_image.shape[1];
    const original_w = input_image.shape[2];

    const image = input_image.resizeBilinear([256, 256]).div(255);
    const bboxes_data = this._getBoundingBox(image);

    if (!bboxes_data[0]) {
      return null;
    }

    const bboxes = bboxes_data[0].arraySync();
    const landmarks = bboxes_data[1];

    const factors = tf.div([original_w, original_h], this.input_size);
    const bb = new Box(tf.tensor(bboxes), landmarks).scale(factors);

    image.dispose();
    bboxes_data[0].dispose();

    return bb;
  }
};