#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon May  6 17:07:14 2019

@author: fraifeld-mba

IMPLEMENTING TUTORIAL https://www.kdnuggets.com/2018/10/simple-neural-network-python.html
"""

import numpy as np
import random

"""
MATH NOTES:
    
    
We use the activation function sigmoid(x) = exp(x)/(1+exp(x)) to help our neural network approximate non linear functions
Without a non-linear activation function, we would not be able to model non-linear functions well.

The derivative to the sigmoid function is x * 1-x

After calculating each neuron's value, this activation function is applied to determine whether or not that neuron will fire.
More on this in the code's comments


Each dimension gets a neuron. In this case, since we are only using a single hidden layer, the network looks like


x1 -- w1 -- INP  |
x2 -- w2 -- UT-  |-- SIGMOID ACTIVATION -- OUTPUT PREDICTION
x3 -- w3 -- FUNC | 



The weights start out random, but they get adjusted through backpropogation and gradient descent. More on that in comments
"""


def generate_training_data():
    
    """
    This table looks like
    
    x1 x2 x3 y
    0  0  1  0 
    1  1  1  1
    1  0  1  1
    0  1  1  0
    """
    
    training_inputs = np.array([[0,0,1],
                                [1,1,1],
                                [1,0,1],
                                [0,1,1]])
    training_outputs = np.array([[0,1,1,0]]).T
    
    return {"input":training_inputs,"output":training_outputs}


def generate_new_situation():
    
    return [random.randint(0,1) for x in range(3)]
    
     
    
class NeuralNetwork():
    def __init__(self):
        # randomly seed the weights
        np.random.seed(1)
        
        # Create a variable for the weights
        # This variable is a vector with three entries representing
        # The weights for each dimension
        # The weights are initialized to a random value between 1 and -1
        self.synaptic_weights = 2 * np.random.random((3,1)) - 1
    
    def sigmoid(self,x):
        # this applies the sigmoid function to the value x passed to the function
        # This is the exact definition of the sigmoid function as described above
        return 1/(1+np.exp(-x))
    
    def sigmoid_derivative(self, x):
        # this calculates the derivative to the sigmoid function
        return x * (1-x)
    
    def train(self, training_inputs, training_outputs, iterations):
        
        # The number of iterations is provided
        # We want to hit a sweet spot - we don't want to fail to approach optimum accuracy
        # But we also don't want to waste a lot of time.
        for i in range(iterations):
            
            
            # Think is going to take the inputs as an argument
            # And then it is going to apply the weights to those inputs (dot product)
            # And apply the sigmoid function to the above
            """
            So if the inputs and weights are 
          
            in         w     dot     sigmoid
            ---       ----   -----   ---------
            1 0 0 1    1       1     1/(1+exp(-1)) =~= .73
            0 0 1 0    0       1     1/(1+exp(-1)) =~= .73
            0 1 0 0    1       0     1/(1+exp(0))   =  .5
            1 1 1 1    0       2     1/(1+exp(-2)) =~= .88
            """
            
            output = self.think(training_inputs)
            # Output is the sigmoid from above
            
            # The training output is 1 or 0 in this toy example. 
            # To get the error, subtract the sigmoid from the output.
            # We try to minimize the error -- gradient descent 
            error = training_outputs-output
            
            # Now we make adjustments based on the error. 
            # Using the sigmoid from above
            """
            Lets say the correct output is
            
            1
            0
            1
            1
            
             in      error * output derivative    
            ---      -------------------------
  
            1 0 0 1    .27 * .1971
            0 0 1 0    -.73 * .1971
            0 1 0 0    .5 * .25
            1 1 1 1    .12 * .1056
            
            We then calculate the dot product, and the entries of the dot product become the adjustments to the weights
            
            
            This is backpropogation.
            """
            
            adjustments = np.dot(training_inputs.T, error*self.sigmoid_derivative(output))
            
            
            # We add these adjustments to the weights. 
            self.synaptic_weights += adjustments
        
    def think(self,inputs):
            
            # convert the inputs so that we can engage in matrix multiplication with floats
            inputs = inputs.astype(float)
            
            
            """
            Repeated comment from above
            So if the inputs and weights are 
          
            in         w     dot     sigmoid
            ---       ----   -----   ---------
            1 0 0 1    1       1     1/(1+exp(-1)) =~= .73
            0 0 1 0    0       1     1/(1+exp(-1)) =~= .73
            0 1 0 0    1       0     1/(1+exp(0))   =  .5
            1 1 1 1    0       2     1/(1+exp(-2)) =~= .88
            """
            # The sigmoid is the output
            output = self.sigmoid(np.dot(inputs,self.synaptic_weights))
            
            return output

if __name__ == "__main__":
    neural_network = NeuralNetwork()
    print("Initial Weights: ")
    print(neural_network.synaptic_weights)
    
    training_data = generate_training_data()
    neural_network.train(training_data["input"],training_data["output"],iterations=15000)
     
    print("New weights after 15000 iterations: ")
    print(neural_network.synaptic_weights)

    print("New situation: ")
    x = generate_new_situation()
    print(x)
    print("Probability of y = 1 : ")
    print(neural_network.think(np.array(x)))
    


















    
    